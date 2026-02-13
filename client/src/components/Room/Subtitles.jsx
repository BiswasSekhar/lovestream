import { useMemo } from 'react';

export default function Subtitles({ cues, currentTime }) {
    const activeCues = useMemo(() => {
        if (!cues || !cues.length) return [];
        return cues.filter((cue) => currentTime >= cue.start && currentTime <= cue.end);
    }, [cues, currentTime]);

    if (activeCues.length === 0) return null;

    return (
        <div className="subtitles">
            {activeCues.map((cue) => (
                <div key={cue.id} className="subtitles__line">
                    {cue.text.split('\n').map((line, i) => (
                        <span key={i}>
                            {line}
                            {i < cue.text.split('\n').length - 1 && <br />}
                        </span>
                    ))}
                </div>
            ))}
        </div>
    );
}
