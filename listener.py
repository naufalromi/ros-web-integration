import requests
import subprocess
import time
import os
import sys

BACKEND_URL = os.environ.get('BACKEND_URL', 'http://localhost')
POLL_INTERVAL = int(os.environ.get('POLL_INTERVAL', '3'))
CONTAINER_NAME = 'ros_turtlebot3_container'
ROS_SETUP = 'source /opt/ros/noetic/setup.bash'
GAZEBO_CMD = 'xvfb-run -a roslaunch turtlebot3_gazebo turtlebot3_world.launch gui:=false'

def exec_in_container(cmd):
    full_cmd = ['docker', 'exec', CONTAINER_NAME, 'bash', '-c', cmd]
    try:
        result = subprocess.run(full_cmd, capture_output=True, text=True, timeout=30)
        return result.returncode == 0, result.stdout, result.stderr
    except subprocess.TimeoutExpired:
        return False, '', 'Timeout'
    except Exception as e:
        return False, '', str(e)

def wait_port_free(port, timeout=15):
    for i in range(timeout):
        _, out, _ = exec_in_container(
            f'ss -tanp 2>/dev/null | grep -q ":{port} " && echo inuse || echo free'
        )
        if 'free' in out:
            return True
        time.sleep(1)
    return False

def start_rosbridge(max_retries=5):
    print('  Waiting port 9090 free...')
    wait_port_free(9090)
    for attempt in range(1, max_retries + 1):
        exec_in_container(
            f'nohup bash -c "{ROS_SETUP} && roslaunch rosbridge_server rosbridge_websocket.launch" > /tmp/rosbridge.log 2>&1 & echo $!'
        )
        time.sleep(2)
        _, out, _ = exec_in_container('pgrep -f "rosbridge" > /dev/null 2>&1 && echo alive || echo dead')
        if 'alive' in out:
            print('  rosbridge started OK')
            return True
        _, _, stderr = exec_in_container('tail -3 /tmp/rosbridge.log')
        print(f'  rosbridge attempt {attempt}/{max_retries} failed: {stderr.strip()}')
        time.sleep(3)
    print('  rosbridge FAILED to start')
    return False

def start_web_video(max_retries=5):
    print('  Waiting port 8080 free...')
    wait_port_free(8080)
    for attempt in range(1, max_retries + 1):
        exec_in_container(
            f'nohup bash -c "{ROS_SETUP} && rosrun web_video_server web_video_server" > /tmp/video.log 2>&1 & echo $!'
        )
        time.sleep(2)
        _, out, _ = exec_in_container('pgrep -f "web_video_server" > /dev/null 2>&1 && echo alive || echo dead')
        if 'alive' in out:
            print('  web_video_server started OK')
            return True
        _, _, stderr = exec_in_container('tail -3 /tmp/video.log')
        print(f'  web_video_server attempt {attempt}/{max_retries} failed: {stderr.strip()}')
        time.sleep(3)
    print('  web_video_server FAILED to start')
    return False

def is_gazebo_running():
    success, stdout, stderr = exec_in_container(
        'source /opt/ros/noetic/setup.bash && rostopic list 2>/dev/null | grep -q /clock && echo "running" || echo "stopped"'
    )
    return success and 'running' in stdout

def kill_all_ros():
    patterns = ['roslaunch', 'gzserver', 'gzclient', 'web_video_server', 'rosbridge']
    for p in patterns:
        exec_in_container(f'for pid in $(pgrep -f "{p}" 2>/dev/null); do kill -9 $pid 2>/dev/null; done')
    exec_in_container('fuser -k 8080/tcp 2>/dev/null; fuser -k 9090/tcp 2>/dev/null')
    wait_port_free(8080, timeout=5)
    wait_port_free(9090, timeout=5)
    print('  Old processes cleaned')

def start_gazebo():
    if is_gazebo_running():
        print('Gazebo already running, skipping')
        return True

    r = subprocess.run(['docker', 'inspect', '-f', '{{.State.Status}}', CONTAINER_NAME],
                      capture_output=True, text=True)
    if 'running' not in r.stdout:
        print('Container not running, starting it...')
        subprocess.run(['docker', 'start', CONTAINER_NAME], timeout=30, capture_output=True)
        time.sleep(5)
    else:
        print('Container already running')

    kill_all_ros()

    success, stdout, stderr = exec_in_container(f'nohup bash -c "{ROS_SETUP} && {GAZEBO_CMD}" > /tmp/gazebo.log 2>&1 & echo $!')
    if not success:
        print(f'Failed to start Gazebo: {stderr}')
        return False

    for i in range(30):
        if is_gazebo_running():
            print(f'Gazebo ready after {i}s')
            start_rosbridge()
            time.sleep(2)
            start_web_video()
            return True
        time.sleep(1)

    print('Gazebo did not become ready in time')
    return False

def stop_gazebo():
    print('Stopping container...')
    subprocess.run(['docker', 'stop', 'ros_turtlebot3_container'], timeout=30, capture_output=True)
    time.sleep(2)
    print('Container stopped')
    return True

def main():
    print(f'Listener started. Backend URL: {BACKEND_URL}')
    while True:
        try:
            resp = requests.get(f'{BACKEND_URL}/api/robot/pending-command', timeout=10)
            if resp.status_code != 200:
                time.sleep(POLL_INTERVAL)
                continue
            cmd = resp.json()
            if cmd is None:
                time.sleep(POLL_INTERVAL)
                continue
            cmd_id = cmd['id']
            action = cmd['action']
            print(f'Processing command #{cmd_id}: {action}')
            if action == 'on':
                ok = start_gazebo()
            elif action == 'off':
                ok = stop_gazebo()
            else:
                ok = False
            status = 'done' if ok else 'failed'
            requests.post(f'{BACKEND_URL}/api/robot/command/{cmd_id}/done',
                          json={'status': status}, timeout=10)
            print(f'Command #{cmd_id} marked as {status}')
        except requests.exceptions.ConnectionError:
            print('Connection to backend failed, retrying...')
        except Exception as e:
            print(f'Error: {e}')
        time.sleep(POLL_INTERVAL)

if __name__ == '__main__':
    main()
