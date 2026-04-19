const modelInput = document.getElementById("modelInput");
const connectBtn = document.getElementById("connectBtn");
const disconnectBtn = document.getElementById("disconnectBtn");
const micBtn = document.getElementById("micBtn");
const statusEl = document.getElementById("status");
const transcriptEl = document.getElementById("transcript");
const clientSessionId = crypto.randomUUID();

let pc;
let dc;
let audioEl;
let localStream;
let micEnabled = true;
const transcriptByItem = new Map();
const handledToolCalls = new Set();

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

    if (name === "delegate_to_brain") {
      appendDebug(`handled_by=${output?.handled_by || "unknown"}`);
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
