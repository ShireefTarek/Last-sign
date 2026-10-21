import { useEffect, useState } from "react";
import { TableScene, type TableLot, type TablePose, type TablePoseChange, type TableSeat } from "./TableScene";

const openingBeats = [
  {
    eyebrow: "الليلة الأولى · مكتب العائلة",
    title: "رحل منصور باشا، وبقي الملف مفتوحاً.",
    copy: "في آخر وصاياه، دعا الورثة إلى مجلسه. لا مفاتيح للخروج قبل أن يُحسم أمر التركة.",
    mark: "١",
  },
  {
    eyebrow: "ستة ملفات · أختام محدودة",
    title: "كل قطعة تحمل وجهاً من الحكاية.",
    copy: "الوثائق أمامكم، والوعود بينكم. راقبوا النظرات؛ فكلمة واحدة قد تغيّر المزايدة.",
    mark: "٢",
  },
  {
    eyebrow: "المشهد الأخير · آخر توقيع",
    title: "في النهاية، سيبقى توقيع واحد.",
    copy: "تفاوضوا، اختاروا ما تثقون به، واكتبوا الفصل الأخير من إرث العائلة.",
    mark: "٣",
  },
];

const roundBeats = [
  { eyebrow: "الجولة الثانية · أثر الأختام", title: "بدأت الوعود تتعارض.", copy: "كل ختم ينتقل إلى يدٍ جديدة يغيّر ميزان المجلس. من يراقب الورق، ومن يراقب الورثة؟", mark: "٢" },
  { eyebrow: "الجولة الثالثة · رسالة في الدرج", title: "ظهرت ورقة لم تكن في الملف.", copy: "خطّ منصور باشا ملاحظة قصيرة عن القطعة الأثمن. الآن صار الصمت نفسه موضع شك.", mark: "٣" },
  { eyebrow: "الجولة الرابعة · حديث الممر", title: "وصلت الإشاعة إلى الطاولة.", copy: "حكاية قديمة تربط أحد الورثة بالختم المفقود. لا أحد يملك الدليل، لكن الجميع صار يقرأ الوجوه.", mark: "٤" },
  { eyebrow: "الجولة الخامسة · الوصية الناقصة", title: "انكشف شرطٌ لم يقرأه أحد.", copy: "بين السطور، ربطت الوصية مصير قطعةٍ بوعدٍ قُطع في المجلس. بقي أن نعرف من سيلتزم به.", mark: "٥" },
  { eyebrow: "الجولة السادسة · ما قبل الأخير", title: "لم يبقَ للثقة مكانٌ واسع.", copy: "اقتربت الأختام من أصحابها، وبدأت التحالفات تتبدل. الحركة التالية قد تحسم مصير الإرث.", mark: "٦" },
  { eyebrow: "الجولة السابعة · آخر توقيع", title: "الملف ينتظر اسماً واحداً.", copy: "هذه آخر فرصة لتغيير الموازين. بعد قفل العروض، ستُقرأ الوعود أمام الجميع.", mark: "٧" },
];

export function StoryCutscene(props: {
  players: TableSeat[];
  lots: TableLot[];
  roundIndex: number;
  localPlayerId?: string | undefined;
  localHand: number[];
  poses: Record<string, TablePose>;
  onPose: (change: TablePoseChange) => void;
  onClose: () => void;
}) {
  const [beatIndex, setBeatIndex] = useState(0);
  const storyBeats = props.roundIndex <= 1 ? openingBeats : [roundBeats[Math.min(props.roundIndex - 2, roundBeats.length - 1)]!];
  const beat = storyBeats[beatIndex]!;

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (beatIndex < storyBeats.length - 1) setBeatIndex((current) => current + 1);
      else props.onClose();
    }, 6200);
    return () => window.clearTimeout(timer);
  }, [beatIndex]);

  const continueStory = () => {
    if (beatIndex < storyBeats.length - 1) setBeatIndex((current) => current + 1);
    else props.onClose();
  };

  return (
    <section className="story-cutscene" role="dialog" aria-modal="true" aria-labelledby="story-title">
      <TableScene
        players={props.players}
        lots={props.lots}
        localPlayerId={props.localPlayerId}
        localHand={props.localHand}
        poses={props.poses}
        onPose={props.onPose}
        cinematic
        interactive={false}
      />
      <div className="story-film-shade" aria-hidden="true" />
      <div className="story-vignette-top"><span className="brand-seal" aria-hidden="true">✦</span><span>آخر توقيع</span><small>حكاية إرثٍ لم يُحسم</small></div>
      <div className="story-caption" key={beatIndex}>
        <div className="story-caption-meta"><span>{beat.mark}</span><p>{beat.eyebrow}</p></div>
        <h1 id="story-title">{beat.title}</h1>
        <p className="story-caption-copy">{beat.copy}</p>
        <div className="story-progress" aria-label={`المشهد ${beatIndex + 1} من ${storyBeats.length}`}>
          {storyBeats.map((item, index) => <i className={index <= beatIndex ? "is-current" : ""} key={item.mark} />)}
        </div>
      </div>
      <div className="story-cutscene-actions">
        <button type="button" className="story-skip" onClick={props.onClose}>تخطي المشهد</button>
        <button type="button" className="primary-button" onClick={continueStory}>{beatIndex === storyBeats.length - 1 ? "ابدأ الجولة" : "تابع الحكاية"}<span aria-hidden="true">↗</span></button>
      </div>
    </section>
  );
}
