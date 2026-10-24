# Live with frens

Simple no-login watch-party rooms for your own screen-share sessions. Anyone can open the site, create a room code, invite friends, share their screen, and talk in real time with mic on or off.

## What this version does

- no login
- no database
- create room or join room with a code
- copy invite link
- screen share from the browser
- group voice chat with mic toggle
- participant list with live status
- room chat

## Best hosting choice

### Recommended: Render

Render is the easiest option for this project because:

- it gives you HTTPS automatically
- WebSocket signaling works fine
- Docker deploy is straightforward
- you do not need to manage a VPS manually

### Good alternative: Railway

Railway is also good and simple, but for a first deployment Render is a little easier to explain and share.

## Why it may fail on the public internet

This project uses WebRTC. If users are on different networks, mobile carriers, office Wi-Fi, or stricter routers, direct peer-to-peer connection can fail unless you also provide a TURN server.

This repo now supports optional TURN credentials through environment variables:

- `TURN_URL`
- `TURN_USERNAME`
- `TURN_CREDENTIAL`

Without TURN, local testing or some home networks may work, but other users may fail to connect, hear audio, or receive screen share.

## Important limit

This app uses a WebRTC mesh, so it is best for small rooms. A practical target is a few friends in one room, not a large public audience.

If later you want many viewers, we should upgrade it to:

- SFU architecture with LiveKit or mediasoup
- optional HLS playback for bigger audiences

## Run locally

```bash
python3 server.py
```

Then open:

- `http://localhost:8000`

## How to use

1. Open the website.
2. Enter your name.
3. Click `Create room` or paste a room code and click `Join room`.
4. Click `Copy invite link` and send it to friends.
5. Everyone joins the same room.
6. Turn mic on if you want voice chat.
7. Click `Start screen share` when you want to show your screen.

## Deploy on Render

1. Push this project to GitHub.
2. Go to Render and create a new Web Service.
3. Connect your GitHub repo.
4. Render will detect the included `Dockerfile`.
5. Deploy it.
6. After deployment, open the Render URL and test room creation.

Because HTTPS is enabled automatically on Render, screen share and microphone permissions will work much more reliably than plain HTTP hosting.

### Recommended Render environment variables

For basic deploy:

- no environment variables are required

For more reliable real-world connectivity:

- add `TURN_URL`
- add `TURN_USERNAME`
- add `TURN_CREDENTIAL`

You can get TURN credentials from providers such as Metered, Twilio, or Xirsys.

## Main files

- `index.html` - room UI
- `styles.css` - responsive design
- `app.js` - room logic, WebRTC, mic toggle, screen share, chat
- `server.py` - static server and WebSocket signaling
- `Dockerfile` - container deploy
- `render.yaml` - Render service definition
