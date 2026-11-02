const nameInput = document.querySelector("#nameInput");
const roomInput = document.querySelector("#roomInput");
const createRoomButton = document.querySelector("#createRoomButton");
const joinRoomButton = document.querySelector("#joinRoomButton");
const copyInviteButton = document.querySelector("#copyInviteButton");
const leaveRoomButton = document.querySelector("#leaveRoomButton");
const toggleMicButton = document.querySelector("#toggleMicButton");
const toggleScreenButton = document.querySelector("#toggleScreenButton");
const roomStateBadge = document.querySelector("#roomStateBadge");
const roomValue = document.querySelector("#roomValue");
const participantCountValue = document.querySelector("#participantCountValue");
const micValue = document.querySelector("#micValue");
const shareValue = document.querySelector("#shareValue");
const connectionValue = document.querySelector("#connectionValue");
const selfNameValue = document.querySelector("#selfNameValue");
const stageVideo = document.querySelector("#stageVideo");
const stagePlaceholder = document.querySelector("#stagePlaceholder");
const stageLabel = document.querySelector("#stageLabel");
const localPreviewVideo = document.querySelector("#localPreviewVideo");
const localPreviewPlaceholder = document.querySelector("#localPreviewPlaceholder");
const previewLabel = document.querySelector("#previewLabel");
const participantList = document.querySelector("#participantList");
const activityFeed = document.querySelector("#activityFeed");
const chatMessages = document.querySelector("#chatMessages");
const chatForm = document.querySelector("#chatForm");
const chatInput = document.querySelector("#chatInput");
const audioDock = document.querySelector("#audioDock");

const DEFAULT_ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

const MAX_SIGNAL_FRAME_BYTES = 3000;
const SIGNAL_CHUNK_SIZE = 1800;
const MAX_SIGNAL_MESSAGE_BYTES = 128 * 1024;
const MAX_PENDING_SIGNAL_MESSAGES = 4;
const SIGNAL_CHUNK_TTL_MS = 10000;

const appState = {
  socket: null,
  socketReady: null,
  heartbeatTimer: null,
  reconnectTimer: null,
  reconnectStabilityTimer: null,
  reconnectAttempts: 0,
  reconnecting: false,
  clientId: null,
  room: "",
  hostId: null,
  displayName: "",
  joined: false,
  joiningRoom: false,
  iceServers: DEFAULT_ICE_SERVERS,
  turnConfigured: false,
  rtcConfigReady: null,
  micTrack: null,
  micEnabled: false,
  screenStream: null,
  screenVideoTrack: null,
  screenAudioTrack: null,
  screenSharing: false,
  stoppingScreen: false,
  participants: new Map(),
  peers: new Map(),
  signalChunks: new Map(),
  stagePeerId: null,
};

function fillEmptyState(container, message) {
  container.innerHTML = `<div class="empty-state">${message}</div>`;
}

fillEmptyState(participantList, "Nobody is in the room yet.");
fillEmptyState(activityFeed, "Room events show up here.");
fillEmptyState(chatMessages, "Chat messages will appear here.");

function nowLabel() {
  return new Date().toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function safeName() {
  return (nameInput.value || "").trim().slice(0, 32);
}

function validateDisplayName() {
  const displayName = safeName();
  nameInput.setCustomValidity(
    displayName ? "" : "Enter your name before creating or joining a room.",
  );
  if (!displayName) {
    nameInput.reportValidity();
    nameInput.focus();
    return "";
  }
  return displayName;
}

function normalizeRoom(rawRoom) {
  const cleaned = (rawRoom || "")
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  return cleaned.slice(0, 24);
}

function generateRoomCode() {
  return `ROOM-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

function getSignalUrl() {
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  return `${protocol}://${window.location.host}/ws`;
}

function setRoomInUrl(room) {
  const nextUrl = new URL(window.location.href);
  if (room) {
    nextUrl.searchParams.set("room", room);
  } else {
    nextUrl.searchParams.delete("room");
  }
  window.history.replaceState({}, "", nextUrl);
}

function sendMessage(payload) {
  if (!appState.socket || appState.socket.readyState !== WebSocket.OPEN) {
    throw new Error("Signal server is not connected.");
  }

  const serialized = JSON.stringify(payload);
  const encoded = new TextEncoder().encode(serialized);
  if (encoded.length <= MAX_SIGNAL_FRAME_BYTES) {
    appState.socket.send(serialized);
    return;
  }

  if (payload.type !== "signal_description" || encoded.length > MAX_SIGNAL_MESSAGE_BYTES) {
    throw new Error("Signaling message is too large to send.");
  }

  let binary = "";
  for (let offset = 0; offset < encoded.length; offset += 0x8000) {
    binary += String.fromCharCode(...encoded.subarray(offset, offset + 0x8000));
  }
  const base64 = btoa(binary);
  const messageId = crypto.randomUUID();
  const chunks = base64.match(new RegExp(`.{1,${SIGNAL_CHUNK_SIZE}}`, "g")) || [""];

  chunks.forEach((data, chunkIndex) => {
    appState.socket.send(JSON.stringify({
      type: "signal_chunk",
      target: payload.target,
      messageId,
      chunkIndex,
      chunkCount: chunks.length,
      data,
    }));
  });
}

function receiveSignalChunk(payload) {
  const { senderId, messageId, chunkIndex, chunkCount, data } = payload;
  if (
    typeof senderId !== "string" ||
    typeof messageId !== "string" ||
    !messageId ||
    !Number.isInteger(chunkIndex) ||
    !Number.isInteger(chunkCount) ||
    chunkCount < 1 ||
    chunkCount > 128 ||
    chunkIndex < 0 ||
    chunkIndex >= chunkCount ||
    typeof data !== "string" ||
    data.length > SIGNAL_CHUNK_SIZE ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(data)
  ) {
    addActivity("Received invalid signaling data; the peer connection may need to retry.");
    return null;
  }

  const now = Date.now();
  appState.signalChunks.forEach((entry, key) => {
    if (entry.createdAt + SIGNAL_CHUNK_TTL_MS < now) {
      appState.signalChunks.delete(key);
    }
  });

  const key = `${senderId}:${messageId}`;
  let entry = appState.signalChunks.get(key);
  if (!entry) {
    if (appState.signalChunks.size >= MAX_PENDING_SIGNAL_MESSAGES) {
      addActivity("Too many signaling messages are pending; retry the room connection.");
      return null;
    }
    entry = {
      senderId,
      chunkCount,
      chunks: new Array(chunkCount),
      receivedChunks: 0,
      receivedBytes: 0,
      createdAt: now,
    };
    appState.signalChunks.set(key, entry);
  }

  if (entry.chunkCount !== chunkCount || entry.senderId !== senderId) {
    appState.signalChunks.delete(key);
    addActivity("Signaling message chunks did not match; retry the peer connection.");
    return null;
  }
  if (entry.chunks[chunkIndex] !== undefined) {
    return null;
  }

  entry.chunks[chunkIndex] = data;
  entry.receivedChunks += 1;
  entry.receivedBytes += data.length;
  if (entry.receivedBytes > Math.ceil(MAX_SIGNAL_MESSAGE_BYTES * 4 / 3)) {
    appState.signalChunks.delete(key);
    addActivity("Signaling message exceeded the allowed size.");
    return null;
  }
  if (entry.receivedChunks !== entry.chunkCount) {
    return null;
  }

  appState.signalChunks.delete(key);
  try {
    const binary = atob(entry.chunks.join(""));
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const message = JSON.parse(new TextDecoder().decode(bytes));
    if (message.type !== "signal_description") {
      throw new Error("Unexpected signaling message type.");
    }
    message.senderId = senderId;
    return message;
  } catch (error) {
    addActivity(`Could not restore a signaling message: ${error.message}`);
    return null;
  }
}

function scheduleSignalReconnect() {
  if (appState.reconnectTimer || !appState.reconnecting) {
    return;
  }

  const delay = Math.min(1000 * 2 ** appState.reconnectAttempts, 30000);
  appState.reconnectAttempts += 1;
  addActivity(`Retrying signal connection in ${Math.ceil(delay / 1000)} seconds...`);
  appState.reconnectTimer = setTimeout(() => {
    appState.reconnectTimer = null;
    ensureSocket().catch((error) => {
      addActivity(`Signal reconnect failed: ${error.message}`);
    });
  }, delay);
}

async function rejoinAfterSignalReconnect() {
  try {
    appState.joiningRoom = true;
    updateUi();
    await ensureRtcConfig(true);
    sendMessage({
      type: "join_room",
      room: appState.room,
      name: appState.displayName,
    });
    addActivity(`Rejoining room ${appState.room}...`);
  } catch (error) {
    appState.joiningRoom = false;
    addActivity(`Could not restore room connection: ${error.message}`);
    appState.socket?.close();
    updateUi();
  }
}

async function ensureRtcConfig(refresh = false) {
  if (refresh) {
    appState.rtcConfigReady = null;
  }

  if (appState.rtcConfigReady) {
    return appState.rtcConfigReady;
  }

  appState.rtcConfigReady = fetch("/config.json")
    .then(async (response) => {
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || `RTC config request failed with ${response.status}`);
      }

      if (Array.isArray(payload.iceServers) && payload.iceServers.length > 0) {
        appState.iceServers = payload.iceServers;
      } else {
        appState.iceServers = DEFAULT_ICE_SERVERS;
      }
      appState.turnConfigured = appState.iceServers.some((server) => {
        const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
        return urls.some((url) => typeof url === "string" && /^turns?:/i.test(url));
      });
      if (!appState.turnConfigured) {
        addActivity("No TURN relay is configured. Screen share and mic may fail between different networks; configure TURN in Render.");
      }
    })
    .catch((error) => {
      appState.turnConfigured = false;
      appState.rtcConfigReady = null;
      addActivity(`RTC configuration failed: ${error.message}`);
      throw error;
    });

  return appState.rtcConfigReady;
}

async function ensureSocket() {
  if (appState.socket && appState.socket.readyState === WebSocket.OPEN) {
    return;
  }

  if (appState.socketReady) {
    return appState.socketReady;
  }

  appState.socketReady = new Promise((resolve, reject) => {
    let opened = false;
    const socket = new WebSocket(getSignalUrl());
    appState.socket = socket;

    socket.addEventListener("open", () => {
      opened = true;
      if (appState.heartbeatTimer) {
        clearInterval(appState.heartbeatTimer);
      }
      appState.heartbeatTimer = setInterval(() => {
        if (appState.socket === socket && socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: "heartbeat" }));
        }
      }, 20000);
      addActivity("Signal server connected.");
      updateUi();
      resolve();
      if (appState.reconnecting) {
        rejoinAfterSignalReconnect();
      }
    });

    socket.addEventListener("message", async (event) => {
      const payload = JSON.parse(event.data);
      await handleSocketMessage(payload);
    });

    socket.addEventListener("close", (event) => {
      if (appState.socket !== socket) {
        return;
      }
      if (appState.heartbeatTimer) {
        clearInterval(appState.heartbeatTimer);
        appState.heartbeatTimer = null;
      }
      if (appState.reconnectStabilityTimer) {
        clearTimeout(appState.reconnectStabilityTimer);
        appState.reconnectStabilityTimer = null;
      }
      appState.socket = null;
      appState.socketReady = null;
      if (!opened) {
        reject(new Error("Signal server connection closed before opening."));
      }
      connectionValue.textContent = "Disconnected";
      addActivity(`Signal server disconnected (code ${event.code}, ${event.wasClean ? "clean" : "unclean"}).`);
      if (appState.joined || appState.joiningRoom || appState.reconnecting) {
        appState.reconnecting = true;
        appState.joined = false;
        appState.joiningRoom = false;
        appState.hostId = null;
        [...appState.peers.keys()].forEach((peerId) => closePeer(peerId));
        resetRoomUi();
        scheduleSignalReconnect();
      }
      updateUi();
    });

    socket.addEventListener("error", () => {
      if (appState.socket === socket) {
        appState.socketReady = null;
      }
      addActivity("Signal server error. Check the server and refresh.");
      reject(new Error("WebSocket connection failed."));
    });
  });

  return appState.socketReady;
}

function addActivity(message) {
  if (activityFeed.querySelector(".empty-state")) {
    activityFeed.innerHTML = "";
  }

  const entry = document.createElement("article");
  entry.className = "feed-entry";
  const time = document.createElement("time");
  time.textContent = nowLabel();
  const detail = document.createElement("div");
  detail.textContent = message;
  entry.append(time, detail);
  activityFeed.prepend(entry);
}

function addChatMessage({ author, text, self = false }) {
  if (chatMessages.querySelector(".empty-state")) {
    chatMessages.innerHTML = "";
  }

  const bubble = document.createElement("article");
  bubble.className = "chat-message";
  const meta = document.createElement("span");
  meta.className = "meta";
  meta.textContent = `${self ? "You" : author} · ${nowLabel()}`;
  const body = document.createElement("div");
  body.className = "body";
  body.textContent = text;
  bubble.append(meta, body);
  chatMessages.prepend(bubble);
}

function showStagePlaceholder(visible) {
  stagePlaceholder.hidden = !visible;
}

function showLocalPreview(visible) {
  localPreviewPlaceholder.hidden = !visible;
}

function updateUi() {
  const connected = appState.socket && appState.socket.readyState === WebSocket.OPEN;
  const isHost = appState.joined && appState.hostId === appState.clientId;

  roomStateBadge.textContent = appState.joined ? (isHost ? "Host live" : "In room") : "Lobby";
  roomStateBadge.classList.toggle("active", appState.joined);

  roomValue.textContent = appState.joined ? appState.room : "Not joined";
  participantCountValue.textContent = String(appState.participants.size || 0);
  micValue.textContent = appState.micEnabled ? "On" : "Off";
  shareValue.textContent = appState.screenSharing ? "On" : "Off";
  connectionValue.textContent = connected ? "Connected" : "Disconnected";
  selfNameValue.textContent = appState.displayName || "Not set";

  toggleMicButton.textContent = appState.micEnabled ? "Turn mic off" : "Turn mic on";
  if (!appState.joined) {
    toggleScreenButton.textContent = "Start screen share";
  } else if (!isHost) {
    toggleScreenButton.textContent = "Only host can share";
  } else {
    toggleScreenButton.textContent = appState.screenSharing
      ? "Stop screen share"
      : "Start screen share";
  }

  createRoomButton.disabled = appState.joined || appState.joiningRoom;
  joinRoomButton.disabled = appState.joined || appState.joiningRoom;
  leaveRoomButton.disabled = !appState.joined && !appState.reconnecting;
  toggleMicButton.disabled = !appState.joined;
  toggleScreenButton.disabled = !appState.joined || !isHost;

  selfNameValue.textContent = isHost
    ? `${appState.displayName} (Host)`
    : appState.displayName || "Not set";
  previewLabel.textContent = appState.screenSharing ? "Sharing now" : "Idle";
  previewLabel.className = "pill";
  if (appState.screenSharing) {
    previewLabel.classList.add("subtle");
  }
}

function renderParticipantList() {
  if (!appState.participants.size) {
    fillEmptyState(participantList, "Nobody is in the room yet.");
    return;
  }

  participantList.innerHTML = "";
  const participants = [...appState.participants.values()].sort((left, right) => {
    if (left.id === appState.clientId) {
      return -1;
    }
    if (right.id === appState.clientId) {
      return 1;
    }
    if (left.screenSharing && !right.screenSharing) {
      return -1;
    }
    if (!left.screenSharing && right.screenSharing) {
      return 1;
    }
    return left.name.localeCompare(right.name);
  });

  participants.forEach((participant) => {
    const card = document.createElement("article");
    card.className = "participant-card";
    const head = document.createElement("div");
    head.className = "participant-head";
    const identity = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = participant.id === appState.clientId
      ? `${participant.name} (You)`
      : participant.name;
    const role = document.createElement("p");
    role.textContent = participant.isHost
      ? "Room host"
      : participant.id === appState.stagePeerId
        ? "On main stage"
        : "In the room";
    identity.append(name, role);

    const shareBadge = document.createElement("span");
    shareBadge.className = `participant-badge ${participant.screenSharing ? "share" : "off"}`;
    shareBadge.textContent = participant.screenSharing ? "Sharing" : "Watching";
    head.append(identity, shareBadge);

    const status = document.createElement("div");
    status.className = "participant-status";
    [
      [participant.isHost ? "Host" : "Guest", participant.isHost],
      [participant.micEnabled ? "Mic on" : "Mic off", participant.micEnabled],
      [participant.id === appState.clientId ? "You" : "Member", participant.id === appState.clientId],
    ].forEach(([label, active]) => {
      const badge = document.createElement("span");
      badge.className = `participant-badge ${active ? "live" : "off"}`;
      badge.textContent = label;
      status.append(badge);
    });

    card.append(head, status);

    participantList.append(card);
  });
}

function getStageCandidates() {
  const candidates = [...appState.participants.values()].filter((participant) => participant.screenSharing);

  if (appState.screenSharing && !candidates.some((participant) => participant.id === appState.clientId)) {
    candidates.unshift({
      id: appState.clientId,
      name: appState.displayName,
      micEnabled: appState.micEnabled,
      screenSharing: true,
    });
  }

  return candidates;
}

function syncAudioOutputs() {
  appState.peers.forEach((peerState, peerId) => {
    peerState.audioElement.muted = false;
    peerState.audioElement.play().then(() => {
      peerState.audioPlaybackBlocked = false;
    }).catch(() => {
      if (!peerState.audioPlaybackBlocked) {
        peerState.audioPlaybackBlocked = true;
        addActivity(`Audio from ${appState.participants.get(peerId)?.name || "a participant"} is blocked by the browser. Click the page and try again.`);
      }
    });
  });
}

async function flushPendingCandidates(peerState) {
  if (!peerState.pendingCandidates.length) {
    return;
  }

  const queued = [...peerState.pendingCandidates];
  peerState.pendingCandidates = [];

  for (const candidate of queued) {
    try {
      await peerState.pc.addIceCandidate(candidate);
    } catch (error) {
      addActivity(`Queued ICE candidate failed for ${peerState.id}: ${error.message}`);
    }
  }
}

function applyStageSource() {
  const candidates = getStageCandidates();
  const activeIds = candidates.map((participant) => participant.id);

  if (!activeIds.includes(appState.stagePeerId)) {
    appState.stagePeerId = activeIds[0] || null;
  }

  if (!appState.stagePeerId) {
    stageVideo.srcObject = null;
    stageVideo.muted = true;
    stageLabel.textContent = "Waiting for screen share";
    stageLabel.className = "pill";
    showStagePlaceholder(true);
    syncAudioOutputs();
    renderParticipantList();
    return;
  }

  if (appState.stagePeerId === appState.clientId && appState.screenStream) {
    stageVideo.srcObject = appState.screenStream;
    stageVideo.muted = true;
    stageLabel.textContent = "You are sharing";
    stageLabel.className = "pill subtle";
    showStagePlaceholder(false);
    syncAudioOutputs();
    renderParticipantList();
    return;
  }

  const stageParticipant = appState.participants.get(appState.stagePeerId);
  const peerState = appState.peers.get(appState.stagePeerId);

  if (peerState && peerState.remoteStream.getVideoTracks().length) {
    stageVideo.srcObject = peerState.remoteStream;
    stageVideo.muted = true;
    stageLabel.textContent = `${stageParticipant?.name || "Guest"} is sharing`;
    stageLabel.className = "pill live";
    showStagePlaceholder(false);
  } else {
    stageVideo.srcObject = null;
    stageVideo.muted = true;
    stageLabel.textContent = `${stageParticipant?.name || "Guest"} is preparing to share`;
    stageLabel.className = "pill";
    showStagePlaceholder(true);
  }

  syncAudioOutputs();
  renderParticipantList();
}

async function announceParticipantStatus() {
  if (!appState.joined || !appState.socket || appState.socket.readyState !== WebSocket.OPEN) {
    return;
  }

  sendMessage({
    type: "participant_status",
    micEnabled: appState.micEnabled,
    screenSharing: appState.screenSharing,
  });
}

async function syncPeerSenders(peerState) {
  await Promise.all([
    peerState.transceivers.mic.sender.replaceTrack(appState.micTrack),
    peerState.transceivers.screenAudio.sender.replaceTrack(appState.screenAudioTrack),
    peerState.transceivers.video.sender.replaceTrack(appState.screenVideoTrack),
  ]);
}

async function syncAllPeerSenders() {
  await Promise.all([...appState.peers.values()].map(async (peerState) => {
    try {
      await syncPeerSenders(peerState);
    } catch (error) {
      addActivity(`Media update failed for ${appState.participants.get(peerState.id)?.name || peerState.id}: ${error.message}`);
    }
  }));
}

function closePeer(peerId) {
  const peerState = appState.peers.get(peerId);
  if (!peerState) {
    return;
  }

  peerState.pc.close();
  peerState.audioElement.srcObject = null;
  peerState.audioElement.remove();
  appState.peers.delete(peerId);
}

function createPeerState(peerId) {
  if (appState.peers.has(peerId)) {
    return appState.peers.get(peerId);
  }

  const pc = new RTCPeerConnection({ iceServers: appState.iceServers });
  const remoteStream = new MediaStream();
  const audioElement = document.createElement("audio");
  audioElement.autoplay = true;
  audioElement.playsInline = true;
  audioElement.srcObject = remoteStream;
  audioDock.append(audioElement);

  const peerState = {
    id: peerId,
    pc,
    remoteStream,
    audioElement,
    polite: appState.clientId > peerId,
    makingOffer: false,
    ignoreOffer: false,
    isSettingRemoteAnswerPending: false,
    pendingCandidates: [],
    iceRestartAttempts: 0,
    audioPlaybackBlocked: false,
    transceivers: {
      mic: pc.addTransceiver("audio", { direction: "sendrecv" }),
      screenAudio: pc.addTransceiver("audio", { direction: "sendrecv" }),
      video: pc.addTransceiver("video", { direction: "sendrecv" }),
    },
  };

  pc.addEventListener("track", (event) => {
    if (!peerState.remoteStream.getTracks().some((track) => track.id === event.track.id)) {
      peerState.remoteStream.addTrack(event.track);
    }

    event.track.addEventListener("ended", () => {
      applyStageSource();
    });

    applyStageSource();
    syncAudioOutputs();
  });

  pc.addEventListener("icecandidate", (event) => {
    if (
      !event.candidate ||
      !appState.joined ||
      appState.peers.get(peerId) !== peerState ||
      !appState.socket ||
      appState.socket.readyState !== WebSocket.OPEN
    ) {
      return;
    }

    sendMessage({
      type: "signal_candidate",
      target: peerId,
      candidate: event.candidate,
    });
  });

  pc.addEventListener("connectionstatechange", () => {
    const state = pc.connectionState;
    addActivity(`Peer ${peerId} is ${state}.`);

    if (state === "closed") {
      closePeer(peerId);
      applyStageSource();
    }
  });

  pc.addEventListener("iceconnectionstatechange", async () => {
    if (pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed") {
      addActivity(`Media connection to ${appState.participants.get(peerId)?.name || "a participant"} is ${pc.iceConnectionState}.`);
    } else if (pc.iceConnectionState === "failed") {
      if (peerState.iceRestartAttempts === 0 && typeof pc.restartIce === "function") {
        peerState.iceRestartAttempts += 1;
        addActivity(`Connection to ${appState.participants.get(peerId)?.name || "a participant"} failed. Retrying network connection...`);
        try {
          await ensureRtcConfig(true);
          pc.setConfiguration({ iceServers: appState.iceServers });
          pc.restartIce();
        } catch (error) {
          addActivity(`ICE restart failed for ${peerId}: ${error.message}`);
        }
      } else {
        addActivity(appState.turnConfigured
          ? `Peer connection to ${appState.participants.get(peerId)?.name || "a participant"} failed after retry. Check that the TURN service is active and its credentials are valid.`
          : "Peer connection failed after retry. Configure METERED_DOMAIN and METERED_API_KEY in Render.");
      }
    }
  });

  pc.addEventListener("negotiationneeded", async () => {
    try {
      peerState.makingOffer = true;
      await syncPeerSenders(peerState);
      await pc.setLocalDescription();

      sendMessage({
        type: "signal_description",
        target: peerId,
        description: pc.localDescription,
      });
    } catch (error) {
      addActivity(`Negotiation failed for ${peerId}: ${error.message}`);
    } finally {
      peerState.makingOffer = false;
    }
  });

  appState.peers.set(peerId, peerState);
  syncPeerSenders(peerState).catch((error) => {
    addActivity(`Media setup failed for ${peerId}: ${error.message}`);
  });
  return peerState;
}

async function handleRemoteDescription(senderId, description) {
  const peerState = createPeerState(senderId);
  const pc = peerState.pc;
  const readyForOffer =
    !peerState.makingOffer &&
    (pc.signalingState === "stable" || peerState.isSettingRemoteAnswerPending);
  const offerCollision = description.type === "offer" && !readyForOffer;

  peerState.ignoreOffer = !peerState.polite && offerCollision;
  if (peerState.ignoreOffer) {
    return;
  }

  peerState.isSettingRemoteAnswerPending = description.type === "answer";

  try {
    if (offerCollision && pc.signalingState !== "stable") {
      await pc.setLocalDescription({ type: "rollback" });
    }

    await pc.setRemoteDescription(description);
    await flushPendingCandidates(peerState);
  } finally {
    peerState.isSettingRemoteAnswerPending = false;
  }

  if (description.type === "offer") {
    await syncPeerSenders(peerState);
    await pc.setLocalDescription();
    sendMessage({
      type: "signal_description",
      target: senderId,
      description: pc.localDescription,
    });
  }
}

async function handleRemoteCandidate(senderId, candidate) {
  const peerState = createPeerState(senderId);
  const iceCandidate = new RTCIceCandidate(candidate);

  if (!peerState.pc.remoteDescription || !peerState.pc.remoteDescription.type) {
    peerState.pendingCandidates.push(iceCandidate);
    return;
  }

  try {
    await peerState.pc.addIceCandidate(iceCandidate);
  } catch (error) {
    if (!peerState.ignoreOffer) {
      peerState.pendingCandidates.push(iceCandidate);
      addActivity(`ICE candidate delayed for ${senderId}: ${error.message}`);
    }
  }
}

function syncParticipants(participants) {
  const nextParticipants = new Map(participants.map((participant) => [participant.id, participant]));
  appState.participants = nextParticipants;

  nextParticipants.forEach((participant, participantId) => {
    if (participantId !== appState.clientId) {
      createPeerState(participantId);
    }
  });

  [...appState.peers.keys()].forEach((peerId) => {
    if (!nextParticipants.has(peerId)) {
      closePeer(peerId);
    }
  });

  applyStageSource();
  renderParticipantList();
  updateUi();
}

function resetRoomUi() {
  appState.participants = new Map();
  appState.stagePeerId = null;
  stageVideo.srcObject = null;
  stageVideo.muted = true;
  showStagePlaceholder(true);
  localPreviewVideo.srcObject = null;
  showLocalPreview(true);
  fillEmptyState(participantList, "Nobody is in the room yet.");
}

async function updateHost(hostId, hostName = "Host") {
  const previousHostId = appState.hostId;
  appState.hostId = hostId || null;

  if (
    appState.screenSharing &&
    appState.hostId &&
    appState.hostId !== appState.clientId
  ) {
    await stopScreenShare("Screen share stopped because only the host can share.", false);
  }

  if (previousHostId && previousHostId !== appState.hostId) {
    addActivity(
      appState.hostId === appState.clientId
        ? "You are now the room host."
        : `${hostName} is now the room host.`,
    );
  }

  renderParticipantList();
  updateUi();
}

async function joinRoom(roomCode) {
  try {
    if (appState.joined) {
      alert("Pehle current room leave karo, phir naya room create ya join karo.");
      return;
    }

    if (appState.joiningRoom) {
      addActivity("Room join request already in progress.");
      return;
    }

    const displayName = validateDisplayName();
    if (!displayName) {
      return;
    }

    const normalizedRoom = normalizeRoom(roomCode);

    if (!normalizedRoom) {
      alert("Room code dalo ya Create room dabao.");
      return;
    }

    if (appState.joined) {
      await leaveRoom("", false);
    }

    appState.joiningRoom = true;
    await ensureRtcConfig();
    await ensureSocket();

    appState.room = normalizedRoom;
    appState.displayName = displayName;
    roomInput.value = normalizedRoom;
    nameInput.value = displayName;
    selfNameValue.textContent = displayName;
    setRoomInUrl(normalizedRoom);

    sendMessage({
      type: "join_room",
      room: normalizedRoom,
      name: displayName,
    });

    addActivity(`Joining room ${normalizedRoom}...`);
    updateUi();
  } catch (error) {
    appState.joiningRoom = false;
    updateUi();
    alert(error.message);
  }
}

async function leaveRoom(message = "Left the room.", notifyServer = true) {
  const wasJoined = appState.joined;

  if (appState.reconnectTimer) {
    clearTimeout(appState.reconnectTimer);
    appState.reconnectTimer = null;
  }
  if (appState.reconnectStabilityTimer) {
    clearTimeout(appState.reconnectStabilityTimer);
    appState.reconnectStabilityTimer = null;
  }
  appState.reconnecting = false;
  appState.reconnectAttempts = 0;

  if (notifyServer && wasJoined && appState.socket && appState.socket.readyState === WebSocket.OPEN) {
    sendMessage({ type: "leave_room" });
  }

  appState.joined = false;
  appState.joiningRoom = false;
  await stopScreenShare("", false);
  stopMicrophone();

  appState.room = normalizeRoom(roomInput.value) || appState.room;
  [...appState.peers.keys()].forEach((peerId) => closePeer(peerId));
  resetRoomUi();
  updateUi();

  if (message) {
    addActivity(message);
  }
}

function stopMicrophone() {
  if (appState.micTrack) {
    appState.micTrack.stop();
  }

  appState.micTrack = null;
  appState.micEnabled = false;
}

async function toggleMic() {
  if (!appState.joined) {
    alert("Join a room first.");
    return;
  }

  try {
    if (!appState.micTrack) {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const [track] = stream.getAudioTracks();

      if (!track) {
        throw new Error("Microphone track was not found.");
      }

      track.enabled = true;
      track.addEventListener("ended", async () => {
        appState.micTrack = null;
        appState.micEnabled = false;
        await syncAllPeerSenders();
        await announceParticipantStatus();
        updateUi();
        addActivity("Microphone stopped.");
      });

      appState.micTrack = track;
      appState.micEnabled = true;
      await syncAllPeerSenders();
    } else {
      appState.micEnabled = !appState.micEnabled;
      appState.micTrack.enabled = appState.micEnabled;
    }

    await announceParticipantStatus();
    updateUi();
    addActivity(appState.micEnabled ? "Microphone turned on." : "Microphone muted.");
  } catch (error) {
    addActivity(`Mic could not start: ${error.message}`);
    alert(`Mic could not start: ${error.message}`);
  }
}

async function stopScreenShare(message = "Screen share stopped.", announce = true) {
  if (appState.stoppingScreen) {
    return;
  }

  appState.stoppingScreen = true;
  const previousStream = appState.screenStream;

  appState.screenStream = null;
  appState.screenVideoTrack = null;
  appState.screenAudioTrack = null;
  appState.screenSharing = false;
  localPreviewVideo.srcObject = null;
  showLocalPreview(true);

  if (previousStream) {
    previousStream.getTracks().forEach((track) => track.stop());
  }

  await syncAllPeerSenders();
  if (announce) {
    await announceParticipantStatus();
  }
  applyStageSource();
  updateUi();

  if (message) {
    addActivity(message);
  }

  appState.stoppingScreen = false;
}

async function toggleScreenShare() {
  if (!appState.joined) {
    alert("Join a room first.");
    return;
  }

  if (appState.hostId !== appState.clientId) {
    alert("Sirf room host hi screen share kar sakta hai.");
    return;
  }

  if (appState.screenSharing) {
    await stopScreenShare("Screen share stopped.");
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 24, max: 30 } },
      audio: true,
    });

    const [videoTrack] = stream.getVideoTracks();
    const [audioTrack] = stream.getAudioTracks();
    if (!videoTrack) {
      throw new Error("No screen video track was captured.");
    }

    const handleShareEnd = () => {
      if (appState.screenSharing) {
        stopScreenShare("Screen share ended.");
      }
    };

    videoTrack.addEventListener("ended", handleShareEnd);
    if (audioTrack) {
      audioTrack.addEventListener("ended", handleShareEnd);
    }

    appState.screenStream = stream;
    appState.screenVideoTrack = videoTrack;
    appState.screenAudioTrack = audioTrack || null;
    appState.screenSharing = true;
    localPreviewVideo.srcObject = stream;
    showLocalPreview(false);

    await syncAllPeerSenders();
    await announceParticipantStatus();
    applyStageSource();
    updateUi();
    addActivity("Screen share started.");
  } catch (error) {
    addActivity(`Screen share could not start: ${error.message}`);
    alert(`Screen share could not start: ${error.message}`);
  }
}

async function copyInviteLink() {
  const roomCode = normalizeRoom(roomInput.value) || appState.room;
  if (!roomCode) {
    alert("Create or join a room first.");
    return;
  }

  const inviteUrl = new URL(window.location.href);
  inviteUrl.searchParams.set("room", roomCode);

  try {
    await navigator.clipboard.writeText(inviteUrl.toString());
    addActivity("Invite link copied.");
  } catch (_error) {
    alert(`Copy this invite link:\n\n${inviteUrl.toString()}`);
  }
}

async function handleSocketMessage(payload) {
  switch (payload.type) {
    case "connection_ready":
      appState.clientId = payload.clientId;
      addActivity(`Connected as client ${payload.clientId}.`);
      break;

    case "room_joined":
      appState.joined = true;
      appState.joiningRoom = false;
      appState.reconnecting = false;
      if (appState.reconnectTimer) {
        clearTimeout(appState.reconnectTimer);
        appState.reconnectTimer = null;
      }
      if (appState.reconnectStabilityTimer) {
        clearTimeout(appState.reconnectStabilityTimer);
      }
      appState.reconnectStabilityTimer = setTimeout(() => {
        appState.reconnectAttempts = 0;
        appState.reconnectStabilityTimer = null;
      }, 30000);
      appState.room = payload.room;
      appState.hostId = payload.hostId || appState.hostId;
      roomInput.value = payload.room;
      setRoomInUrl(payload.room);
      addActivity(`You joined room ${payload.room}.`);
      break;

    case "room_state":
      appState.room = payload.room || appState.room;
      await updateHost(payload.hostId || null);
      syncParticipants(payload.participants || []);
      break;

    case "participant_joined":
      addActivity(`${payload.participant?.name || "A guest"} joined the room.`);
      if (payload.participant?.id && payload.participant.id !== appState.clientId) {
        createPeerState(payload.participant.id);
      }
      break;

    case "participant_left":
      addActivity("A participant left the room.");
      closePeer(payload.participantId);
      if (appState.stagePeerId === payload.participantId) {
        appState.stagePeerId = null;
      }
      applyStageSource();
      break;

    case "signal_description":
      await handleRemoteDescription(payload.senderId, payload.description);
      break;

    case "signal_chunk": {
      const message = receiveSignalChunk(payload);
      if (message) {
        await handleSocketMessage(message);
      }
      break;
    }

    case "signal_candidate":
      await handleRemoteCandidate(payload.senderId, payload.candidate);
      break;

    case "host_changed":
      await updateHost(payload.hostId || null, payload.hostName || "Host");
      break;

    case "chat_message":
      addChatMessage({
        author: payload.author || "Guest",
        text: payload.text || "",
        self: payload.senderId === appState.clientId,
      });
      break;

    case "room_error":
      appState.joiningRoom = false;
      addActivity(payload.message || "Room error.");
      alert(payload.message || "Room error");
      break;

    default:
      break;
  }

  updateUi();
}

function bootstrapFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const room = normalizeRoom(params.get("room") || "");

  if (room) {
    roomInput.value = room;
    addActivity("Invite link detected. Add your name and click Join room.");
  }

  nameInput.value = "";
  appState.displayName = "";
  updateUi();
}

chatForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = chatInput.value.trim();
  if (!text) {
    return;
  }

  if (!appState.joined) {
    alert("Join a room first.");
    return;
  }

  try {
    sendMessage({
      type: "chat_message",
      text,
      author: appState.displayName,
    });
    chatInput.value = "";
  } catch (error) {
    alert(error.message);
  }
});

createRoomButton.addEventListener("click", () => {
  if (appState.joined) {
    alert("Pehle current room leave karo, phir naya room create karo.");
    return;
  }

  if (!validateDisplayName()) {
    return;
  }

  const roomCode = generateRoomCode();
  roomInput.value = roomCode;
  joinRoom(roomCode);
});

joinRoomButton.addEventListener("click", () => {
  if (appState.joined) {
    alert("Pehle current room leave karo, phir doosra room join karo.");
    return;
  }

  joinRoom(roomInput.value);
});

copyInviteButton.addEventListener("click", copyInviteLink);
leaveRoomButton.addEventListener("click", () => leaveRoom("Left the room."));
toggleMicButton.addEventListener("click", toggleMic);
toggleScreenButton.addEventListener("click", toggleScreenShare);
nameInput.addEventListener("input", () => nameInput.setCustomValidity(""));

window.addEventListener("beforeunload", () => {
  if (appState.joined && appState.socket && appState.socket.readyState === WebSocket.OPEN) {
    try {
      sendMessage({ type: "leave_room" });
    } catch (_error) {
      // Ignore unload transport errors.
    }
  }
});

document.addEventListener("pointerdown", syncAudioOutputs);

bootstrapFromUrl();
