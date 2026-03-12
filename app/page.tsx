<div style={{ marginTop: 16 }}>
  {sessionSummary && !running ? (
    <div
      style={{
        width: "min(640px, 100%)",
        minHeight: 480,
        background: "#111",
        border: "1px solid #333",
        borderRadius: 14,
        padding: 24,
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
      }}
    >
      <div style={{ fontSize: 24, fontWeight: 700, marginBottom: 16 }}>Session Summary</div>

      <div style={{ lineHeight: 1.9, fontSize: 17 }}>
        <div>
          <b>Total blinks:</b> {sessionSummary.totalBlinks}
        </div>
        <div>
          <b>Total visible time:</b> {formatDuration(sessionSummary.totalVisibleTimeMs)}
        </div>
        <div>
          <b>Total hidden time:</b> {formatDuration(sessionSummary.totalHiddenTimeMs)}
        </div>
        <div>
          <b>Total session time:</b> {formatDuration(sessionSummary.totalSessionTimeMs)}
        </div>
        <div>
          <b>Average blinks / min:</b> {sessionSummary.averageBlinksPerMinute.toFixed(1)}
        </div>
      </div>

      <div style={{ display: "flex", gap: 10, marginTop: 20, flexWrap: "wrap" }}>
        <button
          onClick={() => {
            setSessionSummary(null);
          }}
          style={{ padding: "10px 16px", cursor: "pointer" }}
        >
          Close Summary
        </button>

        <button
          onClick={() => {
            setSessionSummary(null);
            void start();
          }}
          style={{ padding: "10px 16px", cursor: "pointer" }}
        >
          Start New Session
        </button>
      </div>
    </div>
  ) : running ? (
    <div>
      <video
        ref={videoRef}
        muted
        playsInline
        width={640}
        height={480}
        style={{ borderRadius: 10, background: "#111" }}
      />
      <canvas ref={hiddenCanvasRef} style={{ display: "none" }} />
    </div>
  ) : (
    <div
      style={{
        width: "min(640px, 100%)",
        minHeight: 480,
        borderRadius: 10,
        background: "#111",
        border: "1px solid #222",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        opacity: 0.8,
      }}
    >
      Press Start to begin a new session.
    </div>
  )}
</div>
