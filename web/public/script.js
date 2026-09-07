let ros = null;
let cmdVel = null;
let publishTimer = null;
let reconnectTimeout = null;
let rosUrl = '';
let camUrl = '';
let camRetryCount = 0;
let camRetryTimeout = null;
let reconnectBackoff = 1000;
let rosGeneration = 0;

const statusEl = document.getElementById('status');
const imgEl = document.getElementById('kamera');
const camStatusEl = document.getElementById('camStatus');
const robotStatusEl = document.getElementById('robotStatus');
const toggleRobotBtn = document.getElementById('toggleRobotBtn');
const toggleLogBtn = document.getElementById('toggleLogBtn');
const logPanel = document.getElementById('logPanel');
const logBody = document.getElementById('logBody');
let robotOn = false;
let logPollTimer = null;
let robotStatusInterval = null;
let robotTimeout = null;

function updateStatus(state, msg) {
    const map = {
        connected:    'text-green-500 font-semibold mb-6',
        connecting:   'text-yellow-500 font-semibold mb-6',
        disconnected: 'text-red-500 font-semibold mb-6',
        error:        'text-red-600 font-semibold mb-6'
    };
    statusEl.className = map[state] || map.disconnected;
    statusEl.innerText = msg || ('Status: ' + state.charAt(0).toUpperCase() + state.slice(1));
}

function sendLog(action_type, detail) {
    fetch('/api/log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action_type, detail })
    }).catch(() => {});
}

function publishTwist(linear, angular) {
    if (!ros || !ros.isConnected) return;
    if (!robotOn) return;
    const twist = new ROSLIB.Message({
        linear:  { x: linear,  y: 0.0, z: 0.0 },
        angular: { x: 0.0, y: 0.0, z: angular }
    });
    cmdVel.publish(twist);
}

function startMove(linear, angular) {
    if (!robotOn) return;
    stopMove();
    publishTwist(linear, angular);
    sendLog('velocity', { linear, angular });
    publishTimer = setInterval(() => publishTwist(linear, angular), 100);
}

function stopMove() {
    if (publishTimer) {
        clearInterval(publishTimer);
        publishTimer = null;
    }
    publishTwist(0, 0);
}

function bindButton(id, linear, angular) {
    const btn = document.getElementById(id);
    if (!btn) return;
    btn.addEventListener('mousedown', () => startMove(linear, angular));
    btn.addEventListener('mouseup', stopMove);
    btn.addEventListener('mouseleave', stopMove);
    btn.addEventListener('touchstart', (e) => { e.preventDefault(); startMove(linear, angular); });
    btn.addEventListener('touchend', (e) => { e.preventDefault(); stopMove(); });
}

function connectToRos(url) {
    rosGeneration++;
    const gen = rosGeneration;

    if (ros) {
        try { ros.close(); } catch (_) {}
        ros = null;
    }
    if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
        reconnectTimeout = null;
    }

    if (!url) {
        updateStatus('disconnected', 'Status: Terputus (URL kosong)');
        return;
    }

    updateStatus('connecting', 'Status: Menghubungkan...');
    rosUrl = url;
    reconnectBackoff = 1000;

    ros = new ROSLIB.Ros({ url });

    ros.on('connection', () => {
        updateStatus('connected', 'Status: Terhubung!');
        cmdVel = new ROSLIB.Topic({
            ros: ros,
            name: '/cmd_vel',
            messageType: 'geometry_msgs/Twist'
        });
        reconnectBackoff = 1000;
        sendLog('connect', { url });
    });

    ros.on('error', (e) => {
        console.error('ROS error:', e);
        updateStatus('error', 'Status: Error koneksi');
    });

    ros.on('close', () => {
        if (gen !== rosGeneration) return;
        updateStatus('disconnected', 'Status: Terputus');
        cmdVel = null;
        sendLog('disconnect', { url: rosUrl });
        const delay = reconnectBackoff;
        reconnectBackoff = Math.min(reconnectBackoff * 2, 30000);
        reconnectTimeout = setTimeout(() => connectToRos(rosUrl), delay);
    });
}

function updateCamStatus(state, msg) {
    const map = {
        active: 'text-green-600 text-sm mb-8',
        connecting: 'text-yellow-600 text-sm mb-8',
        error: 'text-red-600 text-sm mb-8',
        idle: 'text-gray-500 text-sm mb-8'
    };
    camStatusEl.className = map[state] || map.idle;
    camStatusEl.innerText = msg || ('Kamera: ' + state.charAt(0).toUpperCase() + state.slice(1));
}

function setCameraUrl(url) {
    if (camRetryTimeout) {
        clearTimeout(camRetryTimeout);
        camRetryTimeout = null;
    }
    camRetryCount = 0;

    if (!url) {
        imgEl.src = '';
        updateCamStatus('idle', 'Kamera: —');
        return;
    }

    // Keep the camera source off the browser-facing network.  The backend
    // proxies the MJPEG stream, preventing HTTP camera URLs from becoming
    // mixed content when this UI is served over HTTPS.
    camUrl = '/api/camera/stream';
    updateCamStatus('connecting', 'Kamera: Menghubungkan...');
    imgEl.src = camUrl + '?topic=/camera/rgb/image_raw&quality=10';

    imgEl.onload = () => {
        updateCamStatus('active', 'Kamera: Aktif');
        camRetryCount = 0;
    };

    imgEl.onerror = () => {
        if (camRetryCount < 3) {
            camRetryCount++;
            updateCamStatus('connecting', `Kamera: Gagal, percobaan ulang ${camRetryCount}/3...`);
            camRetryTimeout = setTimeout(() => {
                imgEl.src = camUrl + '?topic=/camera/rgb/image_raw&quality=10&t=' + Date.now();
            }, 5000);
        } else {
            updateCamStatus('error', 'Kamera: Gagal setelah 3 percobaan');
            sendLog('error', { source: 'kamera', url: camUrl });
        }
    };
}

function restoreLogPanel() {
    const open = localStorage.getItem('logPanelOpen') === 'true';
    if (open) {
        logPanel.classList.remove('hidden');
        toggleLogBtn.innerText = 'Sembunyikan Log';
        fetchLogs();
        logPollTimer = setInterval(fetchLogs, 5000);
    }
}

function toggleLogPanel() {
    const hidden = logPanel.classList.toggle('hidden');
    toggleLogBtn.innerText = hidden ? 'System Log (1 jam terakhir)' : 'Sembunyikan Log';
    localStorage.setItem('logPanelOpen', String(!hidden));
    if (!hidden) {
        fetchLogs();
        logPollTimer = setInterval(fetchLogs, 5000);
    } else {
        clearInterval(logPollTimer);
        logPollTimer = null;
    }
}

async function init() {
    const savedRosbridgeUrl = localStorage.getItem('rosbridgeUrl') || '';
    const savedCameraUrl = localStorage.getItem('cameraUrl') || '';
    const savedRobotOn = localStorage.getItem('robotOn') === 'true';

    if (savedRobotOn) {
        updateRobotStatus(true);
    }

    if (savedRosbridgeUrl) {
        updateStatus('connecting', 'Status: Menghubungkan...');
        setCameraUrl(savedCameraUrl);
        connectToRos(savedRosbridgeUrl);
    }

    try {
        const res = await fetch('/api/config');
        const cfg = await res.json();

        if (cfg.webUrl && window.location.href.startsWith('http://')) {
            window.location.href = cfg.webUrl;
            return;
        }

        const finalRosUrl = cfg.rosbridgeUrl || savedRosbridgeUrl;
        const finalCamUrl = cfg.cameraAvailable ? 'configured' : savedCameraUrl;
        if (cfg.rosbridgeUrl) localStorage.setItem('rosbridgeUrl', cfg.rosbridgeUrl);
        if (cfg.cameraAvailable) localStorage.setItem('cameraUrl', 'configured');
        if (!savedRosbridgeUrl && finalRosUrl) {
            updateStatus('connecting', 'Status: Menghubungkan...');
            setCameraUrl(finalCamUrl);
            connectToRos(finalRosUrl);
        } else if (finalCamUrl) {
            setCameraUrl(finalCamUrl);
        }
    } catch (_) {}

    toggleRobotBtn.addEventListener('click', toggleRobot);
    pollRobotStatus();

    toggleLogBtn.addEventListener('click', toggleLogPanel);
    restoreLogPanel();
}

function updateRobotStatus(on) {
    robotOn = on;
    const state = on ? 'on' : 'off';
    robotStatusEl.className = on
        ? 'text-sm px-3 py-1 rounded bg-green-100 text-green-700 font-semibold'
        : 'text-sm px-3 py-1 rounded bg-gray-200 text-gray-600 font-semibold';
    robotStatusEl.innerText = 'Robot: ' + state.toUpperCase();
    toggleRobotBtn.innerText = on ? 'Matikan Robot' : 'Hidupkan Robot';
    toggleRobotBtn.className = on
        ? 'bg-red-600 text-white px-6 py-2 rounded-lg hover:bg-red-700 font-semibold disabled:opacity-50'
        : 'bg-green-600 text-white px-6 py-2 rounded-lg hover:bg-green-700 font-semibold disabled:opacity-50';
    localStorage.setItem('robotOn', String(on));

    if (on) {
        const cu = localStorage.getItem('cameraUrl');
        if (cu) setCameraUrl(cu);
    } else {
        if (camRetryTimeout) {
            clearTimeout(camRetryTimeout);
            camRetryTimeout = null;
        }
        camRetryCount = 0;
        imgEl.src = '';
        updateCamStatus('idle', 'Kamera: Terputus (Robot OFF)');
    }
}

function toggleRobot() {
    if (robotStatusInterval) clearInterval(robotStatusInterval);
    if (robotTimeout) clearTimeout(robotTimeout);

    toggleRobotBtn.disabled = true;
    toggleRobotBtn.innerText = 'Memproses...';
    const action = robotOn ? 'off' : 'on';

    fetch('/api/robot/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action })
    })
    .then(res => res.json())
    .then(data => {
        console.log('Command sent:', data);
        sendLog(action === 'on' ? 'robot_on' : 'robot_off', {});
        robotStatusInterval = setInterval(pollRobotStatus, 2000);
        robotTimeout = setTimeout(() => {
            if (robotStatusInterval) {
                clearInterval(robotStatusInterval);
                robotStatusInterval = null;
            }
            toggleRobotBtn.disabled = false;
            toggleRobotBtn.innerText = robotOn ? 'Matikan Robot' : 'Hidupkan Robot';
        }, 30000);
    })
    .catch(err => {
        console.error('Gagal kirim command:', err);
        updateRobotStatus(robotOn);
    });
}

function pollRobotStatus() {
    fetch('/api/robot/status')
    .then(res => res.json())
    .then(data => {
        if (data.action === null) {
            const saved = localStorage.getItem('robotOn');
            updateRobotStatus(saved === 'true');
            clearPoll();
        } else if (data.status === 'done' || data.status === 'failed') {
            updateRobotStatus(data.robotOn);
            clearPoll();
        }
    })
    .catch(() => {
        const saved = localStorage.getItem('robotOn');
        updateRobotStatus(saved === 'true');
        clearPoll();
    });
}

function clearPoll() {
    toggleRobotBtn.disabled = false;
    toggleRobotBtn.innerText = robotOn ? 'Matikan Robot' : 'Hidupkan Robot';
    if (robotStatusInterval) {
        clearInterval(robotStatusInterval);
        robotStatusInterval = null;
    }
    if (robotTimeout) {
        clearTimeout(robotTimeout);
        robotTimeout = null;
    }
}

function escapeHtml(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function appendLogEntry(log) {
    const tr = document.createElement('tr');
    tr.className = 'border-b border-gray-200 hover:bg-gray-50';

    const time = new Date(log.created_at).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    let detailStr = '';
    if (log.detail) {
        try { detailStr = JSON.stringify(JSON.parse(log.detail)); } catch { detailStr = log.detail; }
    }

    const typeDisplay = escapeHtml(log.action_type);
    const detailDisplay = escapeHtml(detailStr);
    tr.innerHTML = `
        <td class="px-3 py-1.5 whitespace-nowrap text-gray-500">${time}</td>
        <td class="px-3 py-1.5"><span class="px-1.5 py-0.5 rounded text-xs font-medium ${logClass(log.action_type)}">${typeDisplay}</span></td>
        <td class="px-3 py-1.5 text-gray-600 truncate max-w-xs">${detailDisplay}</td>
    `;
    logBody.prepend(tr);
}

function logClass(type) {
    const map = {
        velocity: 'bg-blue-100 text-blue-700',
        connect: 'bg-green-100 text-green-700',
        disconnect: 'bg-yellow-100 text-yellow-700',
        robot_on: 'bg-green-100 text-green-700',
        robot_off: 'bg-red-100 text-red-700',
        error: 'bg-red-100 text-red-700'
    };
    return map[type] || 'bg-gray-100 text-gray-700';
}

function fetchLogs() {
    fetch('/api/logs?limit=50')
    .then(res => res.json())
    .then(logs => {
        if (!Array.isArray(logs)) return;
        logBody.innerHTML = '';
        logs.forEach(appendLogEntry);
    })
    .catch(() => {});
}

bindButton('btnMaju',   0.5,  0.0);
bindButton('btnMundur', -0.5, 0.0);
bindButton('btnKiri',   0.0,  1.0);
bindButton('btnKanan',  0.0, -1.0);
bindButton('btnStop',   0.0,  0.0);

init();
