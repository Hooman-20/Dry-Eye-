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

## Firebase Setup

1. In the Firebase Console, open your project and go to **Project settings → General → Your apps**.
2. Copy your web app config values.
3. Create a `.env.local` file in the project root and add:

```bash
NEXT_PUBLIC_FIREBASE_API_KEY=your_api_key
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=your_auth_domain
NEXT_PUBLIC_FIREBASE_PROJECT_ID=your_project_id
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=your_storage_bucket
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=your_messaging_sender_id
NEXT_PUBLIC_FIREBASE_APP_ID=your_app_id
```

4. In Firebase Console, enable **Authentication → Sign-in method → Email/Password**.
5. In Firestore rules, ensure authenticated users can write session docs for their own `userId` (and read as desired for your app).

## Auth Flow in This App

- `/signup` creates a Firebase user with email/password.
- `/login` signs in with email/password.
- `/` (Blink Monitor) is protected and redirects to `/login` if no authenticated user exists.
- Session summaries are still saved to Firestore, but now use Firebase Auth UID as `userId`.

Firebase Auth persistence keeps users signed in after refresh by default.

## Quick Testing

1. Run `npm install` and `npm run dev`.
2. Open `http://localhost:3000/signup` and create a test account.
3. Confirm you are redirected to `/` and can start/stop a blink session.
4. Stop a session and verify a Firestore `sessions` document is created with:
   - `userId` equal to the signed-in user UID
   - session summary fields (blinks, score, etc.)
5. Refresh `/` and confirm you stay logged in.
6. Click **Logout** and confirm you are redirected to `/login`.

## Research Disclaimer

This project is a research prototype and not a medical device. Results are experimental and may not be accurate.

If you experience eye pain, discomfort, or vision issues, stop using the tool and contact a qualified medical professional.
