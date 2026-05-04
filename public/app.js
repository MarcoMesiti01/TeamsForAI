const modelInput = document.getElementById("modelInput");
const connectBtn = document.getElementById("connectBtn");
const disconnectBtn = document.getElementById("disconnectBtn");
const micBtn = document.getElementById("micBtn");
const statusEl = document.getElementById("status");
const transcriptEl = document.getElementById("transcript");
const undoBtn = document.getElementById("undoBtn");
const boardStatusEl = document.getElementById("boardStatus");
const boardEl = document.getElementById("board");
const clientSessionId = crypto.randomUUID();

let pc;
let dc;
let audioEl;
let localStream;
let micEnabled = true;
const transcriptByItem = new Map();
const handledToolCalls = new Set();
const NODE_WIDTH = 210;
const NODE_HEIGHT = 112;
let currentBoardState = { version: 0, nodes: [], edges: [], groups: [], can_undo: false };
let dragState = null;

function setStatus(text) {
  statusEl.textContent = `Status: ${text}`;
}

function appendLine(role, text) {
  const div = document.createElement("div");
  div.className = `line ${role}`;
  div.textContent = `${role.toUpperCase()}: ${text}`;
  transcriptEl.appendChild(div);
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
  return div;
}

function appendDebug(text) {
  appendLine("system", `[debug] ${text}`);
}

function getBoardSize(boardState) {
  const nodes = boardState.nodes || [];
  const maxX = Math.max(900, ...nodes.map((node) => Number(node.x || 0) + NODE_WIDTH + 160));
  const maxY = Math.max(520, ...nodes.map((node) => Number(node.y || 0) + NODE_HEIGHT + 160));
  return { width: maxX, height: maxY };
}

function getNodeById(boardState, id) {
  return (boardState.nodes || []).find((node) => node.id === id);
}

function getNodeCenter(node) {
  return {
    x: Number(node.x || 0) + NODE_WIDTH / 2,
    y: Number(node.y || 0) + NODE_HEIGHT / 2,
  };
}

function clearElement(element) {
  while (element.firstChild) {
    element.removeChild(element.firstChild);
  }
}

function createSvgElement(name, attrs = {}) {
  const element = document.createElementNS("http://www.w3.org/2000/svg", name);
  Object.entries(attrs).forEach(([key, value]) => {
    element.setAttribute(key, String(value));
  });
  return element;
}

function drawEdges(edgeLayer, boardState) {
  clearElement(edgeLayer);

  const defs = createSvgElement("defs");
  const marker = createSvgElement("marker", {
    id: "arrowhead",
    markerWidth: 10,
    markerHeight: 10,
    refX: 8,
    refY: 5,
    orient: "auto",
  });
  marker.appendChild(createSvgElement("path", {
    d: "M 0 0 L 10 5 L 0 10 z",
    fill: "#38bdf8",
  }));
  defs.appendChild(marker);
  edgeLayer.appendChild(defs);

  (boardState.edges || []).forEach((edge) => {
    const from = getNodeById(boardState, edge.from);
    const to = getNodeById(boardState, edge.to);
    if (!from || !to) return;

    const start = getNodeCenter(from);
    const end = getNodeCenter(to);
    const midX = (start.x + end.x) / 2;
    const path = createSvgElement("path", {
      d: `M ${start.x} ${start.y} C ${midX} ${start.y}, ${midX} ${end.y}, ${end.x} ${end.y}`,
      class: "edge-path",
      "marker-end": "url(#arrowhead)",
    });
    edgeLayer.appendChild(path);

    if (edge.label) {
      const label = createSvgElement("text", {
        x: midX,
        y: (start.y + end.y) / 2 - 8,
        class: "edge-label",
        textAnchor: "middle",
      });
      label.textContent = edge.label;
      edgeLayer.appendChild(label);
    }
  });
}

function getGroupBounds(boardState, group) {
  const nodes = (group.node_ids || [])
    .map((id) => getNodeById(boardState, id))
    .filter(Boolean);

  if (!nodes.length) return null;

  const left = Math.min(...nodes.map((node) => Number(node.x || 0))) - 28;
  const top = Math.min(...nodes.map((node) => Number(node.y || 0))) - 46;
  const right = Math.max(...nodes.map((node) => Number(node.x || 0) + NODE_WIDTH)) + 28;
  const bottom = Math.max(...nodes.map((node) => Number(node.y || 0) + NODE_HEIGHT)) + 28;

  return { left, top, width: right - left, height: bottom - top };
}

function drawGroups(groupLayer, boardState) {
  clearElement(groupLayer);

  (boardState.groups || []).forEach((group) => {
    const bounds = getGroupBounds(boardState, group);
    if (!bounds) return;

    const region = document.createElement("section");
    region.className = "board-group";
    region.style.left = `${bounds.left}px`;
    region.style.top = `${bounds.top}px`;
    region.style.width = `${bounds.width}px`;
    region.style.height = `${bounds.height}px`;

    const label = document.createElement("span");
    label.className = "board-group-label";
    label.textContent = group.title;
    region.appendChild(label);
    groupLayer.appendChild(region);
  });
}

function refreshBoardGeometry() {
  const edgeLayer = boardEl.querySelector(".board-edges");
  const groupLayer = boardEl.querySelector(".board-groups");
  if (!edgeLayer || !groupLayer) return;

  const size = getBoardSize(currentBoardState);
  boardEl.style.minWidth = `${size.width}px`;
  boardEl.style.minHeight = `${size.height}px`;
  edgeLayer.setAttribute("width", size.width);
  edgeLayer.setAttribute("height", size.height);
  edgeLayer.setAttribute("viewBox", `0 0 ${size.width} ${size.height}`);
  drawGroups(groupLayer, currentBoardState);
  drawEdges(edgeLayer, currentBoardState);
}

function renderBoard(boardState) {
  if (!boardState) return;
  currentBoardState = boardState;

  boardStatusEl.textContent = `Board version: ${boardState.version || 0}`;
  undoBtn.disabled = !boardState.can_undo;
  clearElement(boardEl);

  if (!boardState.nodes?.length) {
    const empty = document.createElement("p");
    empty.className = "board-empty";
    empty.textContent = "No board operations yet.";
    boardEl.appendChild(empty);
    return;
  }

  const size = getBoardSize(boardState);
  boardEl.style.minWidth = `${size.width}px`;
  boardEl.style.minHeight = `${size.height}px`;

  const edgeLayer = createSvgElement("svg", {
    class: "board-edges",
    width: size.width,
    height: size.height,
    viewBox: `0 0 ${size.width} ${size.height}`,
  });
  const groupLayer = document.createElement("div");
  groupLayer.className = "board-groups";
  const nodeLayer = document.createElement("div");
  nodeLayer.className = "board-nodes";

  boardEl.appendChild(groupLayer);
  boardEl.appendChild(edgeLayer);
  boardEl.appendChild(nodeLayer);

  boardState.nodes.forEach((node) => {
    const item = document.createElement("article");
    item.className = `board-node ${node.emphasis === "primary" ? "primary" : ""}`;
    item.dataset.nodeId = node.id;
    item.style.left = `${Number(node.x || 0)}px`;
    item.style.top = `${Number(node.y || 0)}px`;
    item.style.width = `${NODE_WIDTH}px`;
    item.style.minHeight = `${NODE_HEIGHT}px`;

    const title = document.createElement("h3");
    title.textContent = node.text;
    item.appendChild(title);

    const meta = document.createElement("p");
    meta.className = "node-meta";
    meta.textContent = node.emphasis === "primary" ? "Primary thought" : "Idea node";
    item.appendChild(meta);

    item.addEventListener("pointerdown", startNodeDrag);
    nodeLayer.appendChild(item);
  });

  drawGroups(groupLayer, boardState);
  drawEdges(edgeLayer, boardState);
}

function upsertTranscriptItem(itemId, role, text) {
  if (!itemId) {
    appendLine(role, text);
    return;
  }

  const existing = transcriptByItem.get(itemId);
  if (existing) {
    existing.textContent = `${role.toUpperCase()}: ${text}`;
  } else {
    const line = appendLine(role, text);
    transcriptByItem.set(itemId, line);
  }
}

async function getEphemeralKey(model) {
  const resp = await fetch("/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model }),
  });

  const data = await resp.json();
  if (!resp.ok) {
    throw new Error(data?.error || "Unable to create realtime session");
  }

  const token = data?.client_secret?.value;
  if (!token) {
    throw new Error("No ephemeral key returned from backend");
  }

  return token;
}

function bindDataChannel(channel) {
  channel.onopen = () => {
    setStatus("connected");
    appendLine("system", "Realtime data channel connected.");
  };

  channel.onclose = () => {
    appendLine("system", "Realtime data channel closed.");
  };

  channel.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      const type = msg.type;

      if (type === "conversation.item.input_audio_transcription.completed") {
        const text = msg.transcript || "";
        upsertTranscriptItem(msg.item_id, "user", text);
        return;
      }

      if (type === "response.audio_transcript.delta") {
        const previous = transcriptByItem.get(msg.item_id)?.textContent || "ASSISTANT: ";
        const existingText = previous.replace(/^ASSISTANT:\s?/, "");
        upsertTranscriptItem(msg.item_id, "assistant", existingText + (msg.delta || ""));
        return;
      }

      if (type === "response.audio_transcript.done") {
        if (msg.transcript) {
          upsertTranscriptItem(msg.item_id, "assistant", msg.transcript);
        }
        return;
      }

      if (type === "error") {
        appendLine("system", `Error: ${msg.error?.message || "Unknown realtime error"}`);
        return;
      }

      if (type === "response.function_call_arguments.done") {
        const callId = msg.call_id;
        if (!handledToolCalls.has(callId)) {
          handledToolCalls.add(callId);
          void executeToolCall(msg.name, msg.arguments, callId);
        }
        return;
      }

      if (type === "response.output_item.done" && msg.item?.type === "function_call") {
        const callId = msg.item.call_id;
        if (!handledToolCalls.has(callId)) {
          handledToolCalls.add(callId);
          void executeToolCall(msg.item.name, msg.item.arguments, callId);
        }
      }
    } catch {
      // Ignore non-JSON messages
    }
  };
}

async function executeToolCall(name, rawArguments, callId) {
  if (!dc || dc.readyState !== "open") return;

  let parsedArgs = {};
  try {
    parsedArgs = typeof rawArguments === "string" ? JSON.parse(rawArguments || "{}") : (rawArguments || {});
  } catch {
    parsedArgs = {};
  }

  appendLine("system", `Tool call: ${name}`);

  try {
    const resp = await fetch("/tools/execute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        arguments: parsedArgs,
        client_session_id: clientSessionId,
      }),
    });

    const output = await resp.json();

    dc.send(
      JSON.stringify({
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: callId,
          output: JSON.stringify(output),
        },
      })
    );

    dc.send(JSON.stringify({ type: "response.create" }));

    if (output?.board_state) {
      renderBoard(output.board_state);
    }

    if (name === "route_user_intent" || name === "delegate_to_brain") {
      appendDebug(`handled_by=${output?.handled_by || "unknown"}`);
      if (output?.intent?.intent_type) {
        appendDebug(`intent=${output.intent.intent_type}`);
      }
      if (output?.usage) {
        appendDebug(`brain usage recorded`);
      }
      if (output?.save?.file_path) {
        appendLine("system", `Saved flights to: ${output.save.file_path}`);
      }
    }
  } catch (error) {
    appendLine("system", `Tool execution failed (${name}): ${error.message}`);
  }
}

async function undoBoard() {
  try {
    const resp = await fetch("/board/undo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_session_id: clientSessionId }),
    });
    const output = await resp.json();
    renderBoard(output.board_state);
    appendLine("system", output.ok ? "Undid the last board change." : "Nothing to undo.");
  } catch (error) {
    appendLine("system", `Undo failed: ${error.message}`);
  }
}

function startNodeDrag(event) {
  const card = event.currentTarget;
  const node = getNodeById(currentBoardState, card.dataset.nodeId);
  if (!node || event.button !== 0) return;

  card.setPointerCapture(event.pointerId);
  dragState = {
    pointerId: event.pointerId,
    nodeId: node.id,
    card,
    startClientX: event.clientX,
    startClientY: event.clientY,
    startX: Number(node.x || 0),
    startY: Number(node.y || 0),
  };
  card.classList.add("dragging");
}

function moveDraggedNode(event) {
  if (!dragState || event.pointerId !== dragState.pointerId) return;

  const node = getNodeById(currentBoardState, dragState.nodeId);
  if (!node) return;

  const nextX = Math.max(24, dragState.startX + event.clientX - dragState.startClientX);
  const nextY = Math.max(40, dragState.startY + event.clientY - dragState.startClientY);
  node.x = Math.round(nextX);
  node.y = Math.round(nextY);
  dragState.card.style.left = `${node.x}px`;
  dragState.card.style.top = `${node.y}px`;
  refreshBoardGeometry();
}

async function finishNodeDrag(event) {
  if (!dragState || event.pointerId !== dragState.pointerId) return;

  const { card, nodeId, startX, startY } = dragState;
  const node = getNodeById(currentBoardState, nodeId);
  dragState = null;
  card.classList.remove("dragging");

  if (!node || (node.x === startX && node.y === startY)) return;

  try {
    const resp = await fetch("/board/operations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_session_id: clientSessionId,
        operations: [{ type: "move_item", id: nodeId, x: node.x, y: node.y }],
      }),
    });
    const output = await resp.json();
    if (!resp.ok || !output.ok) {
      throw new Error(output?.error || "Unable to save board move");
    }
    renderBoard(output.board_state);
  } catch (error) {
    const failedNode = getNodeById(currentBoardState, nodeId);
    if (failedNode) {
      failedNode.x = startX;
      failedNode.y = startY;
      renderBoard(currentBoardState);
    }
    appendLine("system", `Move failed: ${error.message}`);
  }
}

async function connect() {
  const model = modelInput.value.trim();
  if (!model) {
    alert("Please provide a model name.");
    return;
  }

  connectBtn.disabled = true;
  setStatus("connecting...");

  try {
    const ephemeralKey = await getEphemeralKey(model);

    pc = new RTCPeerConnection();
    audioEl = document.createElement("audio");
    audioEl.autoplay = true;

    pc.ontrack = (event) => {
      audioEl.srcObject = event.streams[0];
    };

    localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const [audioTrack] = localStream.getAudioTracks();
    pc.addTrack(audioTrack, localStream);

    dc = pc.createDataChannel("oai-events");
    bindDataChannel(dc);

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    const sdpResp = await fetch(`https://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ephemeralKey}`,
        "Content-Type": "application/sdp",
      },
      body: offer.sdp,
    });

    if (!sdpResp.ok) {
      const text = await sdpResp.text();
      throw new Error(`SDP exchange failed: ${text}`);
    }

    const answerSdp = await sdpResp.text();
    await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });

    disconnectBtn.disabled = false;
    micBtn.disabled = false;
    micEnabled = true;
    micBtn.textContent = "Mute Mic";
    appendLine("system", `Connected using model: ${model}`);
  } catch (err) {
    appendLine("system", `Connection failed: ${err.message}`);
    setStatus("error");
    cleanup();
  } finally {
    connectBtn.disabled = false;
  }
}

function cleanup() {
  if (dc) {
    dc.close();
    dc = null;
  }

  if (pc) {
    pc.close();
    pc = null;
  }

  if (localStream) {
    localStream.getTracks().forEach((t) => t.stop());
    localStream = null;
  }

  if (audioEl) {
    audioEl.srcObject = null;
    audioEl = null;
  }

  disconnectBtn.disabled = true;
  micBtn.disabled = true;
  setStatus("idle");
}

function disconnect() {
  appendLine("system", "Disconnected.");
  cleanup();
}

function toggleMic() {
  if (!localStream) return;
  micEnabled = !micEnabled;
  localStream.getAudioTracks().forEach((track) => {
    track.enabled = micEnabled;
  });
  micBtn.textContent = micEnabled ? "Mute Mic" : "Unmute Mic";
  appendLine("system", micEnabled ? "Microphone unmuted." : "Microphone muted.");
}

connectBtn.addEventListener("click", connect);
disconnectBtn.addEventListener("click", disconnect);
micBtn.addEventListener("click", toggleMic);
undoBtn.addEventListener("click", undoBoard);
window.addEventListener("pointermove", moveDraggedNode);
window.addEventListener("pointerup", finishNodeDrag);
window.addEventListener("pointercancel", finishNodeDrag);
renderBoard({ version: 0, nodes: [], edges: [], groups: [], can_undo: false });
