import { useEffect, useRef, useState } from "react";
import type { User } from "../../types";
import { socket } from "../../services/socket";

type CallType = "VOICE" | "VIDEO";

type CallStatus =
  | "RINGING"
  | "CALLING"
  | "CONNECTING"
  | "CONNECTED"
  | "ENDED";

interface Call {
  id: string;
  callerId: string;
  receiverId: string;
  type: CallType;
  status: string;
  startedAt?: string | Date | null;
  endedAt?: string | Date | null;
}

interface IncomingCallPayload {
  call: Call;
  caller: User;
}

interface SignalPayload {
  callId: string;
  targetId?: string;
  fromId?: string;
  sdp?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
}

export function CallOverlay({
  me,
}: {
  me: User;
}) {
  const [call, setCall] =
    useState<Call | null>(null);

  const [peer, setPeer] =
    useState<User | null>(null);

  const [status, setStatus] =
    useState<CallStatus>("RINGING");

  const [muted, setMuted] =
    useState(false);

  const [cameraOff, setCameraOff] =
    useState(false);

  const [seconds, setSeconds] =
    useState(0);

  const [error, setError] =
    useState<string | null>(null);

  const [audioBlocked, setAudioBlocked] =
    useState(false);

  const [remoteVideo, setRemoteVideo] =
    useState(false);

  const [remoteConnected, setRemoteConnected] =
    useState(false);

  const callRef =
    useRef<Call | null>(null);

  const peerRef =
    useRef<User | null>(null);

  const pcRef =
    useRef<RTCPeerConnection | null>(null);

  const localStreamRef =
    useRef<MediaStream | null>(null);

  const remoteStreamRef =
    useRef<MediaStream | null>(null);

  const localVideoRef =
    useRef<HTMLVideoElement | null>(null);

  const remoteVideoRef =
    useRef<HTMLVideoElement | null>(null);

  const remoteAudioRef =
    useRef<HTMLAudioElement | null>(null);

  const pendingOfferRef =
    useRef<RTCSessionDescriptionInit | null>(
      null
    );

  /**
   * IMPORTANT:
   * ICE candidates can arrive before the
   * RTCPeerConnection is ready.
   *
   * We queue them instead of losing them.
   */
  const pendingIceCandidatesRef =
    useRef<RTCIceCandidateInit[]>([]);

  const cleanupRef =
    useRef<() => void>(() => {});

  const formatTime = (
    totalSeconds: number
  ) => {
    const minutes = Math.floor(
      totalSeconds / 60
    )
      .toString()
      .padStart(2, "0");

    const secondsPart = (
      totalSeconds % 60
    )
      .toString()
      .padStart(2, "0");

    return `${minutes}:${secondsPart}`;
  };

  /**
   * Play remote audio.
   */
  const playRemoteAudio = async () => {
    const audio =
      remoteAudioRef.current;

    if (!audio) return;

    try {
      await audio.play();

      setAudioBlocked(false);
    } catch {
      /**
       * Browser autoplay policy can block
       * remote audio until user interaction.
       */
      setAudioBlocked(true);
    }
  };

  /**
   * Attach remote stream to audio/video.
   */
  const attachRemoteStream = (
    stream: MediaStream
  ) => {
    remoteStreamRef.current =
      stream;

    const video =
      remoteVideoRef.current;

    if (video) {
      video.srcObject = stream;
      video.autoplay = true;
      video.playsInline = true;
    }

    const audio =
      remoteAudioRef.current;

    if (audio) {
      audio.srcObject = stream;
      audio.autoplay = true;

      void playRemoteAudio();
    }
  };

  /**
   * Create media stream.
   */
  const getMedia = async (
    type: CallType
  ) => {
    if (
      !navigator.mediaDevices ||
      !navigator.mediaDevices.getUserMedia
    ) {
      throw new Error(
        "Your browser does not support microphone/camera access."
      );
    }

    const stream =
      await navigator.mediaDevices.getUserMedia(
        {
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
          video:
            type === "VIDEO"
              ? {
                  width: {
                    ideal: 1280,
                  },
                  height: {
                    ideal: 720,
                  },
                  facingMode: "user",
                }
              : false,
        }
      );

    localStreamRef.current =
      stream;

    if (localVideoRef.current) {
      localVideoRef.current.srcObject =
        stream;

      localVideoRef.current.muted =
        true;

      localVideoRef.current.autoplay =
        true;

      localVideoRef.current.playsInline =
        true;
    }

    return stream;
  };

  /**
   * Flush ICE candidates that arrived
   * before the PeerConnection existed.
   */
  const flushPendingIce = async (
    pc: RTCPeerConnection
  ) => {
    const candidates =
      pendingIceCandidatesRef.current;

    pendingIceCandidatesRef.current =
      [];

    for (const candidate of candidates) {
      try {
        await pc.addIceCandidate(
          candidate
        );
      } catch (err) {
        console.warn(
          "Unable to add queued ICE candidate",
          err
        );
      }
    }
  };

  /**
   * Create PeerConnection.
   */
  const createPeerConnection = async (
    currentCall: Call,
    currentPeer: User,
    stream: MediaStream
  ) => {
    /**
     * Close an old connection if one exists.
     */
    if (pcRef.current) {
      try {
        pcRef.current.close();
      } catch {}
    }

    /**
     * STUN server.
     *
     * TURN can be added later for difficult
     * NAT/mobile/corporate networks.
     */
    const pc =
      new RTCPeerConnection({
        iceServers: [
          {
            urls:
              "stun:stun.l.google.com:19302",
          },
        ],
      });

    pcRef.current = pc;

    /**
     * Add local audio/video tracks.
     */
    for (const track of stream.getTracks()) {
      pc.addTrack(
        track,
        stream
      );
    }

    /**
     * Remote media.
     */
    pc.ontrack = (event) => {
      const stream =
        event.streams?.[0];

      if (!stream) return;

      attachRemoteStream(stream);

      if (
        event.track.kind ===
        "video"
      ) {
        setRemoteVideo(true);
      }

      if (
        event.track.kind ===
        "audio"
      ) {
        void playRemoteAudio();
      }
    };

    /**
     * ICE candidate.
     */
    pc.onicecandidate = (
      event
    ) => {
      if (
        !event.candidate ||
        !currentPeer.id ||
        !socket.connected
      ) {
        return;
      }

      socket.emit(
        "webrtc:ice-candidate",
        {
          callId:
            currentCall.id,
          targetId:
            currentPeer.id,
          candidate:
            event.candidate.toJSON(),
        }
      );
    };

    /**
     * Connection state.
     */
    pc.onconnectionstatechange =
      () => {
        const state =
          pc.connectionState;

        console.log(
          "[WebRTC] connection:",
          state
        );

        if (
          state ===
          "connected"
        ) {
          setStatus(
            "CONNECTED"
          );

          setRemoteConnected(
            true
          );

          void playRemoteAudio();
        }

        if (
          state ===
            "failed" ||
          state ===
            "disconnected"
        ) {
          setRemoteConnected(
            false
          );
        }

        if (
          state ===
          "closed"
        ) {
          setRemoteConnected(
            false
          );
        }
      };

    /**
     * ICE connection state.
     */
    pc.oniceconnectionstatechange =
      () => {
        console.log(
          "[WebRTC] ICE:",
          pc.iceConnectionState
        );
      };

    /**
     * Flush candidates that arrived
     * before this connection was ready.
     */
    await flushPendingIce(pc);

    return pc;
  };

  /**
   * Cleanup everything.
   */
  const cleanup = () => {
    const currentCall =
      callRef.current;

    if (currentCall) {
      /**
       * Do not emit call:end here.
       *
       * Cleanup can also happen because
       * the remote user ended the call.
       */
    }

    if (pcRef.current) {
      try {
        pcRef.current.ontrack =
          null;

        pcRef.current.onicecandidate =
          null;

        pcRef.current.onconnectionstatechange =
          null;

        pcRef.current.close();
      } catch {}
    }

    pcRef.current = null;

    if (localStreamRef.current) {
      for (const track of localStreamRef.current.getTracks()) {
        track.stop();
      }
    }

    localStreamRef.current =
      null;

    if (localVideoRef.current) {
      localVideoRef.current.srcObject =
        null;
    }

    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject =
        null;
    }

    if (remoteAudioRef.current) {
      remoteAudioRef.current.srcObject =
        null;

      remoteAudioRef.current.pause();
    }

    remoteStreamRef.current =
      null;

    pendingOfferRef.current =
      null;

    pendingIceCandidatesRef.current =
      [];

    callRef.current =
      null;

    peerRef.current =
      null;

    setCall(null);
    setPeer(null);
    setStatus("ENDED");
    setMuted(false);
    setCameraOff(false);
    setSeconds(0);
    setError(null);
    setAudioBlocked(false);
    setRemoteVideo(false);
    setRemoteConnected(false);
  };

  cleanupRef.current =
    cleanup;

  /**
   * Timer.
   */
  useEffect(() => {
    if (
      status !==
      "CONNECTED"
    ) {
      return;
    }

    const timer =
      window.setInterval(() => {
        setSeconds(
          (value) =>
            value + 1
        );
      }, 1000);

    return () =>
      window.clearInterval(
        timer
      );
  }, [status]);

  /**
   * Incoming call + WebRTC signalling.
   */
  useEffect(() => {
    /**
     * Incoming call.
     */
    const onIncoming = (
      payload: IncomingCallPayload
    ) => {
      if (
        !payload?.call ||
        !payload?.caller
      ) {
        return;
      }

      /**
       * Ignore calls that aren't for us.
       */
      if (
        payload.call.receiverId !==
        me.id
      ) {
        return;
      }

      /**
       * Don't overwrite an active call.
       */
      if (callRef.current) {
        return;
      }

      callRef.current =
        payload.call;

      peerRef.current =
        payload.caller;

      setCall(
        payload.call
      );

      setPeer(
        payload.caller
      );

      setStatus("RINGING");
      setError(null);
      setSeconds(0);
    };

    /**
     * WebRTC offer.
     *
     * We STORE it because receiver may
     * not have accepted the call yet.
     */
    const onOffer = (
      payload: SignalPayload
    ) => {
      if (!payload?.sdp) {
        return;
      }

      if (
        callRef.current &&
        payload.callId !==
          callRef.current.id
      ) {
        return;
      }

      pendingOfferRef.current =
        payload.sdp;
    };

    /**
     * WebRTC answer.
     */
    const onAnswer = async (
      payload: SignalPayload
    ) => {
      if (!payload?.sdp) {
        return;
      }

      if (
        callRef.current &&
        payload.callId !==
          callRef.current.id
      ) {
        return;
      }

      const pc =
        pcRef.current;

      if (!pc) {
        return;
      }

      try {
        await pc.setRemoteDescription(
          new RTCSessionDescription(
            payload.sdp
          )
        );

        await flushPendingIce(
          pc
        );

        setStatus(
          "CONNECTED"
        );

        void playRemoteAudio();
      } catch (err) {
        console.error(
          "Unable to apply answer",
          err
        );

        setError(
          "Unable to establish the call."
        );
      }
    };

    /**
     * ICE.
     *
     * IMPORTANT:
     * Never discard candidates simply
     * because PC isn't ready yet.
     */
    const onIceCandidate = async (
      payload: SignalPayload
    ) => {
      if (!payload?.candidate) {
        return;
      }

      if (
        callRef.current &&
        payload.callId !==
          callRef.current.id
      ) {
        return;
      }

      const pc =
        pcRef.current;

      if (!pc) {
        pendingIceCandidatesRef.current.push(
          payload.candidate
        );

        return;
      }

      try {
        await pc.addIceCandidate(
          payload.candidate
        );
      } catch (err) {
        console.warn(
          "Unable to add ICE candidate",
          err
        );
      }
    };

    /**
     * Call accepted.
     */
    const onAccepted = (
      payload: {
        call: Call;
      }
    ) => {
      if (
        !payload?.call ||
        !callRef.current
      ) {
        return;
      }

      if (
        payload.call.id !==
        callRef.current.id
      ) {
        return;
      }

      /**
       * Caller waits for WebRTC answer.
       */
      setStatus(
        "CONNECTING"
      );
    };

    /**
     * Rejected.
     */
    const onRejected = (
      payload: {
        call: Call;
      }
    ) => {
      if (
        !payload?.call ||
        !callRef.current
      ) {
        return;
      }

      if (
        payload.call.id !==
        callRef.current.id
      ) {
        return;
      }

      cleanup();
    };

    /**
     * Remote ended.
     */
    const onEnded = (
      payload: {
        call: Call;
      }
    ) => {
      if (
        !payload?.call ||
        !callRef.current
      ) {
        return;
      }

      if (
        payload.call.id !==
        callRef.current.id
      ) {
        return;
      }

      cleanup();
    };

    socket.on(
      "call:incoming",
      onIncoming
    );

    socket.on(
      "call:accepted",
      onAccepted
    );

    socket.on(
      "call:rejected",
      onRejected
    );

    socket.on(
      "call:ended",
      onEnded
    );

    socket.on(
      "webrtc:offer",
      onOffer
    );

    socket.on(
      "webrtc:answer",
      onAnswer
    );

    socket.on(
      "webrtc:ice-candidate",
      onIceCandidate
    );

    return () => {
      socket.off(
        "call:incoming",
        onIncoming
      );

      socket.off(
        "call:accepted",
        onAccepted
      );

      socket.off(
        "call:rejected",
        onRejected
      );

      socket.off(
        "call:ended",
        onEnded
      );

      socket.off(
        "webrtc:offer",
        onOffer
      );

      socket.off(
        "webrtc:answer",
        onAnswer
      );

      socket.off(
        "webrtc:ice-candidate",
        onIceCandidate
      );
    };
  }, [me.id]);

  /**
   * Start outgoing call.
   *
   * The UI dispatches a browser event:
   *
   * window.dispatchEvent(
   *   new CustomEvent("call", {
   *     detail: {
   *       receiver,
   *       type: "VOICE"
   *     }
   *   })
   * )
   */
  useEffect(() => {
    const startCall = async (
      event: Event
    ) => {
      const custom =
        event as CustomEvent;

      const detail =
        custom.detail;

      if (!detail) return;

      const receiver =
        detail.receiver ??
        detail.user ??
        detail.peer;

      const type: CallType =
        detail.type === "VIDEO"
          ? "VIDEO"
          : "VOICE";

      if (!receiver?.id) {
        return;
      }

      if (
        receiver.id === me.id
      ) {
        return;
      }

      if (callRef.current) {
        return;
      }

      if (!socket.connected) {
        setError(
          "Connection is not ready. Please try again."
        );

        return;
      }

      try {
        setError(null);
        setStatus(
          "CONNECTING"
        );

        /**
         * Create DB call.
         */
        const call =
          await new Promise<Call>(
            (
              resolve,
              reject
            ) => {
              socket.emit(
                "call:initiate",
                {
                  receiverId:
                    receiver.id,
                  type,
                },
                (response: any) => {
                  if (
                    response?.success
                  ) {
                    resolve(
                      response.data
                    );
                  } else {
                    reject(
                      new Error(
                        response?.error ??
                          "Unable to start call"
                      )
                    );
                  }
                }
              );
            }
          );

        callRef.current =
          call;

        peerRef.current =
          receiver;

        setCall(call);
        setPeer(receiver);

        /**
         * Ask microphone/camera permission.
         */
        const stream =
          await getMedia(type);

        /**
         * Create PeerConnection.
         */
        const pc =
          await createPeerConnection(
            call,
            receiver,
            stream
          );

        /**
         * Caller creates offer.
         */
        const offer =
          await pc.createOffer({
            offerToReceiveAudio:
              true,
            offerToReceiveVideo:
              type === "VIDEO",
          });

        await pc.setLocalDescription(
          offer
        );

        /**
         * Send offer.
         */
        socket.emit(
          "webrtc:offer",
          {
            callId: call.id,
            targetId:
              receiver.id,
            sdp: offer,
          }
        );

        setStatus(
          "CALLING"
        );
      } catch (err) {
        console.error(
          "Unable to start call",
          err
        );

        setError(
          err instanceof Error
            ? err.message
            : "Unable to start call."
        );

        cleanup();
      }
    };

    window.addEventListener(
      "call",
      startCall
    );

    return () => {
      window.removeEventListener(
        "call",
        startCall
      );
    };
  }, [me.id]);

  /**
   * Accept incoming call.
   */
  const acceptCall = async () => {
    const currentCall =
      callRef.current;

    const currentPeer =
      peerRef.current;

    if (
      !currentCall ||
      !currentPeer
    ) {
      return;
    }

    try {
      setError(null);
      setStatus(
        "CONNECTING"
      );

      /**
       * Get mic/camera.
       */
      const stream =
        await getMedia(
          currentCall.type
        );

      /**
       * Create PC.
       */
      const pc =
        await createPeerConnection(
          currentCall,
          currentPeer,
          stream
        );

      /**
       * Offer may already have arrived.
       */
      const offer =
        pendingOfferRef.current;

      if (!offer) {
        /**
         * Tell backend call accepted,
         * but keep UI in connecting state.
         *
         * Offer can still arrive shortly.
         */
        socket.emit(
          "call:accept",
          {
            callId:
              currentCall.id,
          },
          () => {}
        );

        setStatus(
          "CONNECTING"
        );

        return;
      }

      /**
       * Apply caller offer.
       */
      await pc.setRemoteDescription(
        new RTCSessionDescription(
          offer
        )
      );

      /**
       * Flush any ICE that arrived
       * before remote description.
       */
      await flushPendingIce(
        pc
      );

      /**
       * Create answer.
       */
      const answer =
        await pc.createAnswer();

      await pc.setLocalDescription(
        answer
      );

      /**
       * Update DB call status.
       */
      socket.emit(
        "call:accept",
        {
          callId:
            currentCall.id,
        },
        () => {}
      );

      /**
       * Send WebRTC answer.
       */
      socket.emit(
        "webrtc:answer",
        {
          callId:
            currentCall.id,
          targetId:
            currentPeer.id,
          sdp: answer,
        }
      );

      setStatus(
        "CONNECTED"
      );

      void playRemoteAudio();
    } catch (err) {
      console.error(
        "Unable to accept call",
        err
      );

      setError(
        err instanceof Error
          ? err.message
          : "Unable to accept call."
      );
    }
  };

  /**
   * Reject incoming call.
   */
  const rejectCall = () => {
    const currentCall =
      callRef.current;

    if (!currentCall) {
      return;
    }

    socket.emit(
      "call:reject",
      {
        callId:
          currentCall.id,
      },
      () => {}
    );

    cleanup();
  };

  /**
   * End active call.
   */
  const endCall = () => {
    const currentCall =
      callRef.current;

    if (currentCall) {
      socket.emit(
        "call:end",
        {
          callId:
            currentCall.id,
        },
        () => {}
      );
    }

    cleanup();
  };

  /**
   * Mute/unmute microphone.
   */
  const toggleMute = () => {
    const stream =
      localStreamRef.current;

    if (!stream) return;

    const audioTracks =
      stream.getAudioTracks();

    if (!audioTracks.length) {
      return;
    }

    const nextMuted =
      !muted;

    for (const track of audioTracks) {
      track.enabled =
        !nextMuted;
    }

    setMuted(
      nextMuted
    );
  };

  /**
   * Camera ON/OFF.
   */
  const toggleCamera = () => {
    const stream =
      localStreamRef.current;

    if (!stream) return;

    const videoTracks =
      stream.getVideoTracks();

    if (!videoTracks.length) {
      return;
    }

    const nextOff =
      !cameraOff;

    for (const track of videoTracks) {
      track.enabled =
        !nextOff;
    }

    setCameraOff(
      nextOff
    );
  };

  /**
   * If no call, render nothing.
   */
  if (!call || !peer) {
    return null;
  }

  const isVideo =
    call.type === "VIDEO";

  const isIncoming =
    status === "RINGING" &&
    call.receiverId === me.id;

  const isConnecting =
    status ===
      "CONNECTING" ||
    status === "CALLING";

  return (
    <div
      className="call-overlay"
      role="dialog"
      aria-modal="true"
    >
      {/* Remote video */}
      {isVideo && (
        <video
          ref={remoteVideoRef}
          className="call-remote-video"
          autoPlay
          playsInline
        />
      )}

      {/* Voice/video background */}
      <div className="call-background">
        <div className="call-header">
          <div className="call-peer-info">
            <div className="call-avatar">
              {peer.avatar ? (
                <img
                  src={peer.avatar}
                  alt={
                    peer.displayName
                  }
                />
              ) : (
                peer.displayName
                  ?.charAt(0)
                  .toUpperCase()
              )}
            </div>

            <div>
              <div className="call-peer-name">
                {peer.displayName}
              </div>

              <div className="call-status">
                {status ===
                "CONNECTED"
                  ? formatTime(
                      seconds
                    )
                  : isIncoming
                  ? `Incoming ${
                      isVideo
                        ? "video"
                        : "voice"
                    } call`
                  : status ===
                    "CALLING"
                  ? "Calling..."
                  : "Connecting..."}
              </div>
            </div>
          </div>
        </div>

        {/* Main remote avatar for voice calls */}
        {!isVideo && (
          <div className="call-main-avatar">
            <div className="call-large-avatar">
              {peer.avatar ? (
                <img
                  src={peer.avatar}
                  alt={
                    peer.displayName
                  }
                />
              ) : (
                peer.displayName
                  ?.charAt(0)
                  .toUpperCase()
              )}
            </div>

            <div className="call-large-name">
              {peer.displayName}
            </div>

            <div className="call-large-status">
              {status ===
              "CONNECTED"
                ? formatTime(
                    seconds
                  )
                : isIncoming
                ? "Incoming call"
                : isConnecting
                ? "Connecting..."
                : "Calling..."}
            </div>
          </div>
        )}

        {/* Local video */}
        {isVideo && (
          <div className="call-local-video-wrapper">
            <video
              ref={localVideoRef}
              className="call-local-video"
              autoPlay
              muted
              playsInline
            />

            {cameraOff && (
              <div className="call-camera-off">
                Camera off
              </div>
            )}
          </div>
        )}

        {/* Connection warning */}
        {isVideo &&
          !remoteVideo &&
          status ===
            "CONNECTED" && (
            <div className="call-connection-label">
              Waiting for remote video...
            </div>
          )}

        {/* Audio blocked */}
        {audioBlocked && (
          <button
            type="button"
            className="call-audio-unblock"
            onClick={() => {
              void playRemoteAudio();
            }}
          >
            Tap to enable audio
          </button>
        )}

        {/* Error */}
        {error && (
          <div className="call-error">
            {error}
          </div>
        )}

        {/* Incoming actions */}
        {isIncoming ? (
          <div className="call-incoming-actions">
            <button
              type="button"
              className="call-action call-reject"
              onClick={
                rejectCall
              }
              aria-label="Reject call"
            >
              ✕
            </button>

            <button
              type="button"
              className="call-action call-accept"
              onClick={
                acceptCall
              }
              aria-label="Accept call"
            >
              ✓
            </button>
          </div>
        ) : (
          /* Active call controls */
          <div className="call-controls">
            {isVideo && (
              <button
                type="button"
                className={`call-control ${
                  cameraOff
                    ? "active"
                    : ""
                }`}
                onClick={
                  toggleCamera
                }
                aria-label={
                  cameraOff
                    ? "Turn camera on"
                    : "Turn camera off"
                }
              >
                {cameraOff
                  ? "📷"
                  : "📹"}
              </button>
            )}

            <button
              type="button"
              className={`call-control ${
                muted
                  ? "active"
                  : ""
              }`}
              onClick={
                toggleMute
              }
              aria-label={
                muted
                  ? "Unmute microphone"
                  : "Mute microphone"
              }
            >
              {muted
                ? "🔇"
                : "🎙️"}
            </button>

            <button
              type="button"
              className="call-control call-end"
              onClick={
                endCall
              }
              aria-label="End call"
            >
              ☎
            </button>
          </div>
        )}
      </div>

      {/* Remote audio must stay mounted */}
      <audio
        ref={remoteAudioRef}
        autoPlay
        playsInline
      />
    </div>
  );
}