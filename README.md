# Live with frens

Simple no-login watch-party rooms. Anyone can open the site, create a room code and invite friends. The host can share their screen, and everyone can talk in real time with mic on or off.

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

## TURN relay for public internet

This project uses WebRTC. If users are on different networks, mobile carriers, office Wi-Fi, or stricter routers, direct peer-to-peer connection can fail unless media can be relayed through a TURN server.

The app can fetch TURN credentials from Metered Open Relay on the server. The Metered API key stays in the Render environment and is never sent to the browser:

- `METERED_DOMAIN` - your Metered app domain, such as `your-app.metered.live`
- `METERED_API_KEY` - the TURN REST API key from Metered

Without Metered credentials, the app uses STUN only; some networks may work, but others may fail to connect, hear audio, or receive screen share. The app caches the server-provided ICE configuration briefly and retries failed peer connections once.

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

To enable Metered Open Relay:

1. Create a Metered account and an Open Relay app.
2. In **TURN Server → Credentials**, create a credential. Use **Show API Key** for that credential to get the REST API key; do not use the credential username/password or a separate publishable/signaling key.
3. Copy the app domain (`<app-name>.metered.live`). For this project, the app created as `live-with-frens` uses `live-with-frens.metered.live`.
4. In Render, open the `live-with-frens` web service and go to **Environment**.
5. Add `METERED_DOMAIN` with the app domain and `METERED_API_KEY` with the TURN REST API key. Keep the key private; enter it only in Render.
6. Save the changes and wait for Render to redeploy.
7. Open the site and join a room. The activity feed should not report that TURN is missing. Test screen share and microphone with a friend on a different network.

Metered's dashboard showed a 50 GB free quota when this setup was documented; check your dashboard for the current allowance and pricing. TURN relays consume quota according to the amount of relayed audio/video data, so screen sharing can use quota quickly.

The server requests ICE credentials from `https://<METERED_DOMAIN>/api/v1/turn/credentials` and never returns the API key to clients. If the key is exposed, revoke it in Metered and create a replacement.

## Main files

- `index.html` - room UI
- `styles.css` - responsive design
- `app.js` - room logic, WebRTC, mic toggle, screen share, chat
- `server.py` - static server and WebSocket signaling
- `Dockerfile` - container deploy
- `render.yaml` - Render service definition
