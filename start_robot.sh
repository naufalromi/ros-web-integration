#!/bin/bash

export TURTLEBOT3_MODEL=waffle
source /opt/ros/noetic/setup.bash

# Patch camera resolution to 160x120 @ 15fps
XACRO=/opt/ros/noetic/share/turtlebot3_description/urdf/turtlebot3_waffle.gazebo.xacro
sed -i 's|<width>[0-9]*</width>|<width>160</width>|g' "$XACRO"
sed -i 's|<height>[0-9]*</height>|<height>120</height>|g' "$XACRO"
sed -i 's|<updateRate>[0-9.]*</updateRate>|<updateRate>15.0</updateRate>|g' "$XACRO"
echo "[+] Camera resolution patched to 160x120 @ 15fps"
touch /tmp/robot-container-ready

# Keep container alive — listener starts Gazebo on demand when user clicks ON
tail -f /dev/null
