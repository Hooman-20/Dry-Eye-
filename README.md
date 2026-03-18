# Blink Monitor (Webcam)

A browser-based research prototype that uses your webcam to detect blinks, monitor time since the last blink, and alert you when no blink is detected for a selected period.

## Live Demo

[Try the app here](https://dry-eye-efmy.vercel.app)

## Overview

Blink Monitor is a webcam-based tool designed to help users become more aware of their blinking behavior during screen use. The app tracks blinks in real time, estimates blinks per minute, detects long no-blink periods, and provides audio and desktop notification alerts when needed.

This project is intended for research and educational purposes only. It is not a medical device and should not be used for diagnosis or treatment.

## Features

- Real-time blink detection using webcam input
- Automatic eye calibration at the start of each session
- Live blink counter
- Blinks-per-minute tracking
- Time since last blink display
- Configurable no-blink alert threshold
- Repeating alarm until a blink is detected
- Optional desktop notifications
- Face detection awareness so alerts pause when no face is visible
- Session summary after each run
- Session grading based on blinking behavior and session quality

## How It Works

The app uses the webcam to capture video and detect facial landmarks. It estimates whether the eyes are open or closed by measuring eye geometry frame by frame. After a short calibration period, the system begins monitoring blinking activity.

During a session, the app tracks:

- total blinks
- average blinks per minute
- seconds since last blink
- visible vs hidden session time
- number of no-blink alerts
- longest no-blink streak
- session score and grade

If the user does not blink for longer than the selected threshold, the app triggers an alert and can also send a desktop notification if permission is enabled.

## Tech Stack

- Next.js
- React
- TypeScript
- MediaPipe Face Mesh
- Web Notifications API
- Web Audio API
- Vercel for deployment

## Research Disclaimer

This project is a research prototype and not a medical device. Results are experimental and may not be accurate.

If you experience eye pain, discomfort, or vision issues, stop using the tool and contact a qualified medical professional.

