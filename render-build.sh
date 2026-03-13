#!/usr/bin/env bash
# Install dependencies
npm install

# FFmpeg is needed for voice
apt-get update
apt-get install -y ffmpeg
