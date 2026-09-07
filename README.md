# ROS Web Teleoperation

Web-based teleoperation system for Turtlebot3 Waffle simulation using ROS Noetic and Gazebo 11.

## Architecture

```
Browser  <-->  Web container  <-->  MySQL container
                  |
                  +-----------> ROS/Gazebo container
                                     ^
                                     |
                              listener.py (host)
```

Docker Compose manages the web application, MySQL, and ROS/Gazebo together. The
listener remains on the Docker host because it starts and stops Gazebo through
the local Docker socket.

## Tech Stack

- ROS Noetic, Gazebo 11, rosbridge_server, web_video_server
- Node.js (Express), MySQL 8
- Python 3 (listener)
- Docker Compose
- Frontend: HTML5, Tailwind CSS, roslibjs

## Features

- Real-time robot teleoperation via browser (WebSocket to rosbridge)
- Live camera stream from Gazebo simulation (MJPEG via web_video_server)
- ON/OFF robot control (start/stop Gazebo, rosbridge, web_video_server remotely)
- Persistent state (robot status, camera feed, connection restore on browser refresh)
- System logging to MySQL with auto-delete after 1 hour
- XSS protection, input validation, URL whitelisting

## Setup

### Docker host

Requirements: Docker Engine with Compose, Python 3, and the Python `requests`
package for the listener.

```bash
git clone <repo-url> ros-web-integration
cd ros-web-integration
cp .env.example .env
# Edit .env and replace both database passwords.
docker compose up -d --build
export BACKEND_URL=http://localhost
python3 listener.py
```

### Browser

Open `http://localhost`. For a browser on another machine in the same
network, set `ROSBRIDGE_URL=ws://<docker-host-ip>:9090` in `.env`, restart the
`web` service, then open `http://<docker-host-ip>`.

## Startup Order

1. Copy `.env.example` to `.env` and set passwords.
2. Run `docker compose up -d --build`.
3. Run `BACKEND_URL=http://localhost python3 listener.py` on the Docker host.
4. Open the browser URL above.
