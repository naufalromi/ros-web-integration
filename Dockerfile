FROM osrf/ros:noetic-desktop-full

RUN apt-get update && apt-get install -y \
    ros-noetic-turtlebot3-simulations \
    ros-noetic-turtlebot3 \
    ros-noetic-rosbridge-server \
    ros-noetic-web-video-server \
    xvfb \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*

RUN echo 'source /opt/ros/noetic/setup.bash' >> ~/.bashrc

COPY start_robot.sh /start_robot.sh
RUN chmod +x /start_robot.sh

HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD test -f /tmp/robot-container-ready

CMD ["bash", "/start_robot.sh"]
