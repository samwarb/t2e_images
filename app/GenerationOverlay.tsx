type Props = {
  title?: string;
  description: string;
  progress?: { current: number; total: number };
};

export default function GenerationOverlay({ title = "Generating image", description, progress }: Props) {
  const percent = progress ? Math.max(0, Math.min(100, (progress.current / progress.total) * 100)) : null;

  return <div className="generation-overlay" role="status" aria-live="polite" aria-atomic="true">
    <section className="generation-card" aria-label={title}>
      <div className="generation-art" aria-hidden="true">
        <div className="generation-art-back" />
        <div className="generation-art-front"><span className="generation-art-dish"><i /></span></div>
        <span className="generation-sparkle generation-sparkle-one">✦</span>
        <span className="generation-sparkle generation-sparkle-two">✧</span>
        <span className="generation-sparkle generation-sparkle-three">✳</span>
      </div>
      <div className="generation-eyebrow">T2E IMAGE LIBRARY</div>
      <h2>{title}</h2>
      <p>{description}</p>
      <div className="generation-progress-track" aria-hidden="true">
        <span className={percent === null ? "generation-progress-fill indeterminate" : "generation-progress-fill"} style={percent === null ? undefined : { width: `${percent}%` }} />
      </div>
      {progress && <small>Image {progress.current} of {progress.total}</small>}
    </section>
  </div>;
}
