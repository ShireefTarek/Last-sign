import { useEffect, useMemo, useRef, useState } from "react";
import type { getStory } from "@akher-tawqee/game-engine";
import { TableScene, type TableLot, type TablePose, type TablePoseChange, type TableSeat } from "./TableScene";

type Story = ReturnType<typeof getStory>;
type StoryChapter = "opening" | "middle" | "ending";

export function StoryCutscene(props: {
  story: Story;
  chapter: StoryChapter;
  winnerName?: string | undefined;
  scandal: number;
  players: TableSeat[];
  lots: TableLot[];
  localPlayerId?: string | undefined;
  localHand: number[];
  localHandLabels: string[];
  poses: Record<string, TablePose>;
  onPose: (change: TablePoseChange) => void;
  onClose: () => void;
}) {
  const [speaking, setSpeaking] = useState(false);
  const [voiceNotice, setVoiceNotice] = useState("");
  const closeRef = useRef(props.onClose);
  closeRef.current = props.onClose;
  const scene = useMemo(() => {
    if (props.chapter === "opening") return { eyebrow: `قصة جديدة · ${props.story.genre}`, title: `الليلة بدأت في «${props.story.title}»`, copy: props.story.opening, action: "ادخلوا المجلس" };
    if (props.chapter === "middle") return { eyebrow: `نص الحكاية · ${props.story.title}`, title: "اللي حصل قلب كل التوقعات.", copy: props.story.middle, action: "كمّلوا" };
    const ending = props.scandal >= 6 ? "الفضيحة وصلت لآخرها، ومحدش هيخرج من المجلس بنفس الأسرار اللي دخل بيها." : "كل اختيار اتسجل، وكل ورقة أخيراً لقت صاحبها.";
    return { eyebrow: `آخر الحكاية · ${props.story.title}`, title: `المزاد كسبه ${props.winnerName ?? "أحد الورثة"}… بس دي مش الحكاية كلها.`, copy: `${props.story.twist} ${ending}`, action: "اقفل الملف" };
  }, [props.chapter, props.scandal, props.story, props.winnerName]);

  useEffect(() => {
    const timer = window.setTimeout(() => closeRef.current(), props.chapter === "ending" ? 15_000 : 12_000);
    return () => window.clearTimeout(timer);
  }, [props.chapter]);

  useEffect(() => () => {
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
  }, []);

  const speak = () => {
    if (!("speechSynthesis" in window) || !("SpeechSynthesisUtterance" in window)) {
      setVoiceNotice("المتصفح ده مش بيدعم القراءة الصوتية.");
      return;
    }
    if (speaking) {
      window.speechSynthesis.cancel();
      setSpeaking(false);
      return;
    }
    const voices = window.speechSynthesis.getVoices();
    const voice = voices.find((item) => item.lang.toLowerCase() === "ar-eg")
      ?? voices.find((item) => item.lang.toLowerCase().startsWith("ar"));
    const utterance = new SpeechSynthesisUtterance(`${scene.title}. ${scene.copy}`);
    utterance.lang = voice?.lang ?? "ar-EG";
    utterance.rate = 0.92;
    if (voice) utterance.voice = voice;
    utterance.onstart = () => { setSpeaking(true); setVoiceNotice(voice ? "" : "الصوت العربي المتاح من جهازك هيُستخدم لو موجود."); };
    utterance.onend = () => setSpeaking(false);
    utterance.onerror = () => { setSpeaking(false); setVoiceNotice("ماقدرناش نشغّل الصوت على الجهاز ده."); };
    window.speechSynthesis.speak(utterance);
  };

  return (
    <section className="story-cutscene" role="dialog" aria-modal="true" aria-labelledby="story-title">
      <TableScene
        players={props.players}
        lots={props.lots}
        localPlayerId={props.localPlayerId}
        localHand={props.localHand}
        localHandLabels={props.localHandLabels}
        poses={props.poses}
        onPose={props.onPose}
        cinematic
        interactive={false}
      />
      <div className="story-film-shade" aria-hidden="true" />
      <div className="story-vignette-top"><span className="brand-seal" aria-hidden="true">✦</span><span>آخر توقيع</span><small>{props.story.genre} · قصة بتتغيّر مع لعبكم</small></div>
      <article className="story-caption" key={props.chapter}>
        <div className="story-caption-meta"><span>{props.chapter === "opening" ? "١" : props.chapter === "middle" ? "٢" : "٣"}</span><p>{scene.eyebrow}</p></div>
        <h1 id="story-title">{scene.title}</h1>
        <p className="story-caption-copy">{scene.copy}</p>
        <div className="story-progress" aria-label="بداية ووسط ونهاية الحكاية">
          {(["opening", "middle", "ending"] as const).map((chapter) => <i className={["opening", "middle", "ending"].indexOf(props.chapter) >= ["opening", "middle", "ending"].indexOf(chapter) ? "is-current" : ""} key={chapter} />)}
        </div>
      </article>
      <div className="story-cutscene-actions">
        <div className="story-voice-action">
          <button type="button" className="story-skip" onClick={speak}>{speaking ? "وقّف الصوت" : "اسمع الحكاية"}</button>
          {voiceNotice && <small role="status">{voiceNotice}</small>}
        </div>
        <button type="button" className="primary-button" onClick={props.onClose}>{scene.action}<span aria-hidden="true">↗</span></button>
      </div>
    </section>
  );
}
