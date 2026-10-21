import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { io, type Socket } from "socket.io-client";
import { CARD_SOURCE, finalScore } from "@akher-tawqee/game-engine";
import type { TablePose, TablePoseChange, TableSeat } from "./TableScene";

const TableScene = lazy(() => import("./TableScene").then((module) => ({ default: module.TableScene })));
const StoryCutscene = lazy(() => import("./StoryCutscene").then((module) => ({ default: module.StoryCutscene })));

type RoomPlayerView = {
  playerId: string;
  displayName: string;
  seatIndex: number;
  isHost: boolean;
  ready: boolean;
  connected: boolean;
};

type LotView = {
  id: string;
  nameAr: string;
  rewardType: "influence" | "draw-card" | "remove-suspicion";
  rewardAmount: number;
  status: "open" | "won" | "unclaimed";
  winnerPlayerId?: string;
};

type GamePlayerView = {
  playerId: string;
  displayName: string;
  seatIndex: number;
  influence: number;
  seals: number;
  suspicion: number;
  wagerScore: number;
  connected: boolean;
  ready: boolean;
  declarationLocked: boolean;
  declaration?: { targetLotId?: string; alternateLotId?: string; bidBand?: "0-1" | "2-3"; stance?: { kind: "trust" | "doubt"; targetPlayerId: string } };
  declarationMasked?: boolean;
  oneDeclarationFieldHidden?: boolean;
  declarationChange?: { fromLotId: string; toLotId: string };
  actionLocked: boolean;
};

type GameView = {
  gameId: string;
  roundIndex: number;
  roundLimit: number;
  phase: string;
  stateVersion: number;
  scandal: number;
  finalRoundMarked: boolean;
  deadlineAt?: number;
  paused: boolean;
  lots: LotView[];
  players: GamePlayerView[];
  events: Array<{ id: string; sequence: number; type: string; payload: Record<string, unknown> }>;
};

type RoomView = {
  roomCode: string;
  status: "lobby" | "playing" | "complete";
  version: number;
  hostPlayerId: string;
  settings: { mode: string; roundLimit: number; chatEnabled: boolean; negotiationSeconds: number };
  players: RoomPlayerView[];
  game?: GameView;
};

type PrivateView = {
  playerId: string;
  game?: { hand: number[]; lockedCardId?: number; cardParameters?: Record<string, string | number | boolean>; declaration?: unknown; wagers?: unknown[]; action?: unknown; wagersLocked?: boolean };
};

type AckResponse = {
  ok: boolean;
  requestId: string;
  data?: { room?: RoomView; player?: { playerId: string }; reconnectToken?: string; private?: unknown };
  error?: { code: string; message: string };
  snapshot?: RoomView;
};

type RoomMessage = { playerId: string; displayName: string; message: string };

const PLAYABLE_CARDS = new Map<number, { name: string; effect: string }>([
  [1, { name: "الافتتاح العلني", effect: "إذا فزت بالقطعة التي أعلنتها، تحصل على +١ إلى العرض الفعلي." }],
  [3, { name: "الزيادة المحسوبة", effect: "تدفع ١ نفوذ عند المزايدة لتحصل على +٢ إلى العرض الفعلي." }],
  [4, { name: "تأمين الخاسر", effect: "إذا خسرت بعد عرض غير صفري، تسترد ١ نفوذ." }],
  [5, { name: "نصف السعر", effect: "إذا فزت بعرض أساسي ٢ أو ٣، تسترد ١ نفوذ بعد تثبيت الفائز." }],
  [6, { name: "وسيط الثقة", effect: "تحصل على +١ إلى العرض إذا وثق بك لاعب اختار القطعة نفسها." }],
  [8, { name: "عمولة الوسيط", effect: "اختر لاعباً؛ إذا اخترتما قطعتين مختلفتين، يحصل كل منكما على ١ نفوذ." }],
  [10, { name: "سلفة الورثة", effect: "تكسب ١ نفوذ فوراً؛ إن فزت تسدد ٢، وإن لم تفز يضاف إليك شك واحد." }],
  [11, { name: "إعادة التفاوض", effect: "قبل قفل اختيارك النهائي، ادفع ١ نفوذ لتعديل القطعة المعلنة. يظل الإعلان الأصلي محفوظاً للتوقعات." }],
  [12, { name: "رغبة مشتركة", effect: "اختر لاعباً؛ إذا اخترتما قطعتين مختلفتين، يحصل كل منكما على ١ نفوذ." }],
  [13, { name: "عمولة المزاد", effect: "إذا فزت بقطعة تنافس عليها لاعبان حقيقيان، تكسب ١ نفوذ." }],
  [14, { name: "العرض الأخير", effect: "إذا كان عرضك الفعلي أقل بنقطة واحدة من الأعلى، تدفع ١ نفوذ وتضيف نقطة." }],
  [15, { name: "قبول محسوب", effect: "الفوز بأكثر القطع ازدحاماً يمنحك ١ نفوذ؛ وبأقلها ازدحاماً يزيل ١ شك." }],
  [16, { name: "نيتان", effect: "أعلن قطعتين؛ إذا اخترت الأقل ازدحاماً منهما، تحصل على +١ إلى العرض." }],
  [18, { name: "إعلان مقنّع", effect: "يُحجب إعلانك عن الآخرين حتى يقفل الجميع توقعاتهم، ثم يظهر قبل التفاوض." }],
  [21, { name: "إشاعة محسوبة", effect: "اختر لاعباً: إذا غيّر القطعة المعلنة تكسب ١ نفوذ؛ وإلا يضاف إليه ١ شك." }],
  [22, { name: "حساب متناقض", effect: "إن خالف عرضك الأساسي نطاقك المعلن، تحصل على +١ إلى العرض وتضيف ١ شك إلى رصيدك." }],
  [23, { name: "قصاصة مفقودة", effect: "اختر حقلاً معلناً واحداً لإخفائه. يرى الآخرون أن حقلاً واحداً محجوب." }],
  [25, { name: "صدى الكلمات", effect: "اختر إعلان لاعب علنيّاً لتكراره؛ تكسب ١ نفوذ إذا اختار قطعة مختلفة في النهاية." }],
  [26, { name: "علامة زائفة", effect: "انقل ١ شك من رصيدك إلى لاعب تختاره؛ يبلغ الشك حداً أقصاه ٣." }],
  [31, { name: "رسم التناقض", effect: "إذا خالف اللاعب القطعة التي أعلنها، يضاف إليه ١ شك؛ وإلا تدفع أنت ١ نفوذ." }],
  [32, { name: "عقرب الساعة", effect: "تضيف ٢ إلى الفضيحة. تُفحص قيمة الفضيحة عند نهاية الجولة فقط." }],
  [35, { name: "ضغط الحشد", effect: "إذا تنافس ٣ لاعبين حقيقيين على القطعة الأكثر ازدحاماً، تنخفض عروضهم الفعلية نقطة ويزيد مؤشر الفضيحة نقطة." }],
  [37, { name: "شرط قاسٍ", effect: "اختر قطعة. من أعلنها عليه أن يزايد بنقطة أساسية على الأقل أو يدفع ١ نفوذ إضافياً إن كان قادراً؛ المرور يخضع للكلفة." }],
  [40, { name: "فاتورة النفوذ", effect: "عند قفل العروض، يدفع كل لاعب بقي لديه ٤ نفوذ على الأقل نقطة واحدة إلى المصرف." }],
  [43, { name: "فضيحة متراكمة", effect: "تضيف ١ فضيحة، أو ٢ إذا كان المؤشر ٦ فأكثر قبل أثر البطاقة. الفحص للجولة التالية يتم عند نهايتها." }],
  [47, { name: "سجل موثق", effect: "أزل ١ شك؛ إذا لم يكن لديك شك، تكسب ١ نفوذ بدلاً منه." }],
  [48, { name: "ضمان الخاسر", effect: "إذا خسرت بعد عرض غير صفري، تسترد ١ نفوذ." }],
  [54, { name: "صندوق الطوارئ", effect: "إذا لم تفز بقطعة هذه الجولة، تكسب ١ نفوذ حتى الحد الأقصى." }],
  [56, { name: "هدنة قصيرة", effect: "أزل ١ من الفضيحة وأضف ١ شك إلى مسارك." }],
]);

function requestId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function rewardLabel(lot: LotView): string {
  if (lot.rewardType === "influence") return `+${lot.rewardAmount} نفوذ`;
  if (lot.rewardType === "draw-card") return `سحب ${lot.rewardAmount} بطاقة`;
  return `إزالة ${lot.rewardAmount} شك من المسار`;
}

function phaseLabel(phase: string): string {
  const labels: Record<string, string> = {
    declaration: "الإعلان العام",
    "wager-commit": "التوقعات السرية",
    negotiation: "التفاوض",
    "final-action": "الاختيار النهائي السري",
    resolution: "كشف الاختيارات",
    "round-summary": "ملخص الجولة",
    complete: "انتهت المباراة",
  };
  return labels[phase] ?? phase;
}

function errorMessage(error: AckResponse["error"]): string {
  return error?.message ?? "تعذّر تنفيذ الطلب. حاول مرة أخرى.";
}

export default function App() {
  const [socket, setSocket] = useState<Socket | null>(null);
  const [connected, setConnected] = useState(false);
  const [room, setRoom] = useState<RoomView | null>(null);
  const [privateState, setPrivateState] = useState<PrivateView | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [roomCode, setRoomCode] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [largeText, setLargeText] = useState(false);
  const [reduceMotion, setReduceMotion] = useState(false);
  const [chatMessages, setChatMessages] = useState<RoomMessage[]>([]);
  const [chatDraft, setChatDraft] = useState("");
  const [declarationLot, setDeclarationLot] = useState("");
  const [alternateDeclarationLot, setAlternateDeclarationLot] = useState("");
  const [declarationBand, setDeclarationBand] = useState<"0-1" | "2-3" | "">("");
  const [selectedCardId, setSelectedCardId] = useState<number | "">("");
  const [cardTargetId, setCardTargetId] = useState("");
  const [cardTargetLotId, setCardTargetLotId] = useState("");
  const [renegotiationLot, setRenegotiationLot] = useState("");
  const [hiddenDeclarationField, setHiddenDeclarationField] = useState<"targetLotId" | "bidBand" | "">("");
  const [wagerTarget, setWagerTarget] = useState("");
  const [wagerLot, setWagerLot] = useState("");
  const [finalLot, setFinalLot] = useState("");
  const [baseBid, setBaseBid] = useState(0);
  const [stanceKind, setStanceKind] = useState<"pass" | "trust" | "doubt">("pass");
  const [stanceTarget, setStanceTarget] = useState("");
  const [shareNotice, setShareNotice] = useState("");
  const [tablePoses, setTablePoses] = useState<Record<string, TablePose>>({});
  const [storySceneKey, setStorySceneKey] = useState("");
  const seenStoryRef = useRef("");

  const inviteCodeFromUrl = useMemo(() => {
    const match = window.location.pathname.match(/^\/join\/([A-Za-z0-9]{6})\/?$/);
    return match?.[1]?.toUpperCase() ?? "";
  }, []);

  const clearError = () => setError("");

  const send = useCallback((event: string, payload: Record<string, unknown>, scope: "lobby" | "game" = "lobby") => {
    if (!socket?.connected) {
      setError("الاتصال بالخادم غير متاح حالياً.");
      return Promise.resolve<AckResponse>({ ok: false, requestId: "offline", error: { code: "OFFLINE", message: "الاتصال غير متاح" } });
    }
    const game = room?.game;
    const envelope: Record<string, unknown> = {
      version: 1,
      scope,
      requestId: requestId(),
      ...payload,
    };
    if (room && event !== "CREATE_ROOM" && event !== "JOIN_ROOM" && event !== "RECONNECT") {
      envelope.expectedStateVersion = scope === "game" ? game?.stateVersion : room.version;
      if (scope === "game" && game) {
        envelope.gameId = game.gameId;
        envelope.roundIndex = game.roundIndex;
      }
    }
    return new Promise<AckResponse>((resolveResponse) => {
      socket.timeout(10_000).emit(event, envelope, (timeoutError: Error | null, response: AckResponse) => {
        if (timeoutError) {
          setError("انتهت مهلة الاتصال بالخادم. أعد المحاولة بعد تحديث الحالة.");
          resolveResponse({ ok: false, requestId: String(envelope.requestId), error: { code: "TIMEOUT", message: "انتهت مهلة الاتصال" } });
          return;
        }
        if (!response?.ok) {
          setError(errorMessage(response?.error));
          if (response?.snapshot) setRoom(response.snapshot);
        } else {
          clearError();
        }
        resolveResponse(response);
      });
    });
  }, [room, socket]);

  useEffect(() => {
    const connection = io({ autoConnect: false, transports: ["websocket", "polling"] });
    setSocket(connection);
    const onConnect = () => {
      setConnected(true);
      const savedCode = inviteCodeFromUrl || localStorage.getItem("akher:last-room") || "";
      const token = savedCode ? localStorage.getItem(`akher:${savedCode}:token`) : null;
      if (savedCode && token) {
        connection.emit("RECONNECT", { version: 1, scope: "lobby", requestId: requestId(), roomCode: savedCode, reconnectToken: token }, (response: AckResponse) => {
          if (!response?.ok || !response.data?.room) {
            localStorage.removeItem(`akher:${savedCode}:token`);
            setRoomCode(savedCode);
            return;
          }
          setRoom(response.data.room);
          setRoomCode(savedCode);
          setPrivateState(response.data.private as PrivateView);
          window.history.replaceState(null, "", `/join/${savedCode}`);
        });
      } else if (inviteCodeFromUrl) {
        setRoomCode(inviteCodeFromUrl);
        setJoinCode(inviteCodeFromUrl);
      }
    };
    const onDisconnect = () => setConnected(false);
    const onRoom = (nextRoom: RoomView) => setRoom(nextRoom);
    const onPrivate = (next: PrivateView) => setPrivateState(next);
    const onChat = (message: RoomMessage) => setChatMessages((messages) => [...messages.slice(-29), message]);
    const onTableAction = (value: unknown) => {
      if (typeof value !== "object" || value === null) return;
      const pose = value as TablePose;
      if (typeof pose.playerId !== "string" || typeof pose.updatedAt !== "number" || !pose.lookAt) return;
      setTablePoses((current) => ({ ...current, [pose.playerId]: pose }));
    };
    const onValidationError = (payload: { message?: string }) => setError(payload.message ?? "تعذر تنفيذ الطلب");
    connection.on("connect", onConnect);
    connection.on("disconnect", onDisconnect);
    connection.on("ROOM_SNAPSHOT", onRoom);
    connection.on("PLAYER_PRIVATE_SNAPSHOT", onPrivate);
    connection.on("PUBLIC_CHAT_MESSAGE", onChat);
    connection.on("TABLE_ACTION", onTableAction);
    connection.on("VALIDATION_ERROR", onValidationError);
    connection.connect();
    return () => {
      connection.off("connect", onConnect);
      connection.off("disconnect", onDisconnect);
      connection.off("ROOM_SNAPSHOT", onRoom);
      connection.off("PLAYER_PRIVATE_SNAPSHOT", onPrivate);
      connection.off("PUBLIC_CHAT_MESSAGE", onChat);
      connection.off("TABLE_ACTION", onTableAction);
      connection.off("VALIDATION_ERROR", onValidationError);
      connection.disconnect();
    };
  }, [inviteCodeFromUrl]);

  const sendTablePose = useCallback((change: TablePoseChange) => {
    const playerId = privateState?.playerId;
    if (!playerId || !socket?.connected) return;
    const previous = tablePoses[playerId];
    const pose: TablePose = {
      playerId,
      lookAt: change.lookAt ?? previous?.lookAt ?? { kind: "center" },
      gesture: change.gesture === undefined ? previous?.gesture ?? null : change.gesture,
      updatedAt: Date.now(),
    };
    setTablePoses((current) => ({ ...current, [playerId]: pose }));
    socket.emit("TABLE_ACTION", { lookAt: pose.lookAt, gesture: pose.gesture });
  }, [privateState?.playerId, socket, tablePoses]);

  const saveRoom = (response: AckResponse) => {
    if (!response.ok || !response.data?.room) return false;
    const code = response.data.room.roomCode;
    setRoom(response.data.room);
    setRoomCode(code);
    localStorage.setItem("akher:last-room", code);
    if (response.data.reconnectToken) localStorage.setItem(`akher:${code}:token`, response.data.reconnectToken);
    if (response.data.player?.playerId) localStorage.setItem(`akher:${code}:player`, response.data.player.playerId);
    window.history.replaceState(null, "", `/join/${code}`);
    return true;
  };

  const onCreate = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    const response = await send("CREATE_ROOM", { displayName }, "lobby");
    saveRoom(response);
    setBusy(false);
  };

  const onJoin = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    const code = (joinCode || roomCode || inviteCodeFromUrl).trim().toUpperCase();
    const response = await send("JOIN_ROOM", { displayName, roomCode: code }, "lobby");
    saveRoom(response);
    setBusy(false);
  };

  const sendGameAction = async (event: string, payload: Record<string, unknown>) => {
    setBusy(true);
    const response = await send(event, payload, "game");
    if (response.ok && response.data?.private) setPrivateState(response.data.private as PrivateView);
    setBusy(false);
  };

  const ready = async () => {
    if (!room) return;
    const me = room.players.find((player) => player.playerId === privateState?.playerId);
    await send("READY", { ready: !me?.ready }, "lobby");
  };

  const copyText = async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setShareNotice(`تم نسخ ${label}`);
    } catch {
      window.prompt(`انسخ ${label}:`, value);
      setShareNotice("يمكنك نسخ النص من الحقل المفتوح");
    }
  };

  const shareRoom = async () => {
    if (!room) return;
    const url = `${window.location.origin}/join/${room.roomCode}`;
    if (navigator.share) {
      try {
        await navigator.share({ title: "آخر توقيع", text: `انضموا إلى غرفتي برمز ${room.roomCode}`, url });
      } catch {
        // A dismissed native share sheet is not an error.
      }
    } else {
      await copyText(url, "رابط الدعوة");
    }
  };

  const currentPlayer = room?.players.find((player) => player.playerId === privateState?.playerId);
  const game = room?.game;
  const tableSeats: TableSeat[] = useMemo(() => room?.players.map((player) => ({
    playerId: player.playerId,
    displayName: player.displayName,
    seatIndex: player.seatIndex,
    connected: player.connected,
    isYou: player.playerId === privateState?.playerId,
  })) ?? [], [room?.players, privateState?.playerId]);
  const showLanding = !room;

  useEffect(() => {
    const gameId = game?.gameId;
    const roundIndex = game?.roundIndex;
    if (!gameId || roundIndex === undefined) return;
    const sceneKey = `${gameId}:${roundIndex}`;
    if (seenStoryRef.current === sceneKey) return;
    const storageKey = `akher:story:${sceneKey}`;
    seenStoryRef.current = sceneKey;
    if (sessionStorage.getItem(storageKey)) return;
    sessionStorage.setItem(storageKey, "seen");
    setStorySceneKey(sceneKey);
  }, [game?.gameId, game?.roundIndex]);

  return (
    <div className={`app-shell ${largeText ? "large-text" : ""} ${reduceMotion ? "reduce-motion" : ""}`}>
      <header className="topbar">
        <a className="brand" href="/" onClick={(event) => { event.preventDefault(); if (!room) window.history.pushState(null, "", "/"); }} aria-label="آخر توقيع، الصفحة الرئيسية">
          <span className="brand-seal" aria-hidden="true">✦</span>
          <span><strong>آخر توقيع</strong><small>حكاية مزايدة بين الورثة</small></span>
        </a>
        <div className="topbar-side">
          <span className={`connection ${connected ? "is-online" : ""}`}><i aria-hidden="true" />{connected ? "متصل بالخادم" : "جارٍ الاتصال"}</span>
          <button className="icon-button" type="button" onClick={() => setLargeText((value) => !value)} aria-pressed={largeText} aria-label="تكبير الخط">عـ</button>
          <button className="icon-button" type="button" onClick={() => setReduceMotion((value) => !value)} aria-pressed={reduceMotion} aria-label="تقليل الحركة">◌</button>
        </div>
      </header>

      <main className="page-frame">
        {error && <div className="error-banner" role="alert"><span>{error}</span><button type="button" onClick={clearError} aria-label="إغلاق التنبيه">×</button></div>}
        {showLanding && (
          <section className="landing-grid">
            <div className="hero-panel paper-panel">
              <div className="eyebrow"><span className="eyebrow-line" /> لعبة ورثة، أختام، ومزايدات سرية</div>
              <h1>كل وثيقة لها ثمن.<br /><em>وكل توقيع له أثر.</em></h1>
              <p className="hero-copy">اجتمعوا حول طاولة الميراث. أعلنوا نواياكم، توقّعوا تحركات بعضكم، ثم قدّموا عروضكم في اللحظة الأخيرة.</p>
              <div className="hero-stamp" aria-hidden="true"><span>ملفّ العائلة</span><strong>مُختوم</strong><i>١٩٢٤</i></div>
              <div className="quick-rules">
                <h2>كيف تبدأ الحكاية؟</h2>
                <ol>
                  <li><b>أنشئ غرفة</b><span>أرسل الرمز أو الرابط إلى أصدقائك.</span></li>
                  <li><b>اختر بحذر</b><span>كل جولة فيها إعلان وتوقع وعرض سري.</span></li>
                  <li><b>اجمع الأختام</b><span>أعلى رصيد يفوز عند نهاية الملف.</span></li>
                </ol>
              </div>
            </div>
            <section className="entry-card" aria-labelledby="entry-title">
              <div className="entry-mark" aria-hidden="true">✒</div>
              <p className="eyebrow">لا حسابات. لا تطبيق. فقط دعوة.</p>
              <h2 id="entry-title">ادخل إلى المجلس</h2>
              <form onSubmit={onCreate} className="entry-form">
                <label htmlFor="display-name">اسمك على سجل الورثة</label>
                <input id="display-name" autoComplete="nickname" maxLength={20} value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="مثال: ندى" required />
                <button className="primary-button" type="submit" disabled={busy || !connected}>{busy ? "لحظة..." : "إنشاء غرفة جديدة"}<span aria-hidden="true">↗</span></button>
              </form>
              <div className="divider"><span>أو انضم لغرفة موجودة</span></div>
              <form onSubmit={onJoin} className="join-form">
                <label htmlFor="room-code">رمز الدعوة</label>
                <div className="join-row">
                  <input id="room-code" autoCapitalize="characters" maxLength={6} value={joinCode} onChange={(event) => setJoinCode(event.target.value.toUpperCase())} placeholder={inviteCodeFromUrl || "A2K7QP"} required />
                  <button className="secondary-button" type="submit" disabled={busy || !connected}>انضم</button>
                </div>
              </form>
              <p className="entry-footnote"><span aria-hidden="true">◇</span> من ٣ إلى ١٢ لاعباً · الجولات اختيارية بلا عقوبة للمرور</p>
            </section>
          </section>
        )}

        {room && room.status === "lobby" && (
          <Lobby
            room={room}
            tableSeats={tableSeats}
            poses={tablePoses}
            onPose={sendTablePose}
            currentPlayer={currentPlayer}
            displayName={displayName}
            setDisplayName={setDisplayName}
            onReady={ready}
            onStart={() => void send("START_GAME", {}, "lobby")}
            onUpdateSettings={(settings) => void send("UPDATE_ROOM_SETTINGS", { settings }, "lobby")}
            onCopyCode={() => void copyText(room.roomCode, "رمز الغرفة")}
            onCopyLink={() => void copyText(`${window.location.origin}/join/${room.roomCode}`, "رابط الدعوة")}
            onShare={() => void shareRoom()}
            shareNotice={shareNotice}
          />
        )}

        {room && room.status !== "lobby" && game && storySceneKey === `${game.gameId}:${game.roundIndex}` && (
          <Suspense fallback={<div className="table-scene-loading story-loading">يُفتح ملفّ العائلة...</div>}>
            <StoryCutscene
              key={storySceneKey}
              players={tableSeats}
              lots={game.lots}
              roundIndex={game.roundIndex}
              localPlayerId={privateState?.playerId}
              localHand={privateState?.game?.hand ?? []}
              poses={tablePoses}
              onPose={sendTablePose}
              onClose={() => setStorySceneKey("")}
            />
          </Suspense>
        )}

        {room && room.status !== "lobby" && game && storySceneKey !== `${game.gameId}:${game.roundIndex}` && (
          <GameRoom
            room={room}
            game={game}
            tableSeats={tableSeats}
            tablePoses={tablePoses}
            onTablePose={sendTablePose}
            privateState={privateState}
            currentPlayer={currentPlayer}
            busy={busy}
            declarationLot={declarationLot}
            setDeclarationLot={setDeclarationLot}
            alternateDeclarationLot={alternateDeclarationLot}
            setAlternateDeclarationLot={setAlternateDeclarationLot}
            declarationBand={declarationBand}
            setDeclarationBand={setDeclarationBand}
            selectedCardId={selectedCardId}
            setSelectedCardId={setSelectedCardId}
            cardTargetId={cardTargetId}
            setCardTargetId={setCardTargetId}
            cardTargetLotId={cardTargetLotId}
            setCardTargetLotId={setCardTargetLotId}
            renegotiationLot={renegotiationLot}
            setRenegotiationLot={setRenegotiationLot}
            hiddenDeclarationField={hiddenDeclarationField}
            setHiddenDeclarationField={setHiddenDeclarationField}
            wagerTarget={wagerTarget}
            setWagerTarget={setWagerTarget}
            wagerLot={wagerLot}
            setWagerLot={setWagerLot}
            finalLot={finalLot}
            setFinalLot={setFinalLot}
            baseBid={baseBid}
            setBaseBid={setBaseBid}
            stanceKind={stanceKind}
            setStanceKind={setStanceKind}
            stanceTarget={stanceTarget}
            setStanceTarget={setStanceTarget}
            onGameAction={sendGameAction}
            onNextRound={() => void send("NEXT_ROUND", {}, "game")}
            chatMessages={chatMessages}
            chatDraft={chatDraft}
            setChatDraft={setChatDraft}
            onChat={async () => {
              if (!chatDraft.trim()) return;
              const response = await send("SEND_PUBLIC_CHAT", { message: chatDraft.trim() }, "lobby");
              if (response.ok) setChatDraft("");
            }}
          />
        )}
      </main>

      <footer className="page-footer"><span>آخر توقيع <b>·</b> نسخة أولية قيد التطوير</span><span>لا تُسجّل الدردشة ضمن سجل المباراة</span></footer>
    </div>
  );
}

function Lobby(props: {
  room: RoomView;
  tableSeats: TableSeat[];
  poses: Record<string, TablePose>;
  onPose: (change: TablePoseChange) => void;
  currentPlayer: RoomPlayerView | undefined;
  displayName: string;
  setDisplayName: (value: string) => void;
  onReady: () => void;
  onStart: () => void;
  onUpdateSettings: (settings: Record<string, unknown>) => void;
  onCopyCode: () => void;
  onCopyLink: () => void;
  onShare: () => void;
  shareNotice: string;
}) {
  const allReady = props.room.players.length >= 3 && props.room.players.every((player) => player.ready);
  const isHost = props.currentPlayer?.isHost ?? false;
  return (
    <section className="room-shell">
      <div className="room-heading">
        <div><p className="eyebrow">مجلس الورثة · غرفة انتظار</p><h1>الطاولة جاهزة تقريباً</h1><p>أرسل الدعوة، واترك لكل لاعب مقعده قبل فتح الملف.</p></div>
        <div className="room-code-card"><span>رمز الغرفة</span><strong dir="ltr">{props.room.roomCode}</strong><small>٦ أحرف · استخدمه للانضمام</small></div>
      </div>
      <div className="room-toolbar">
        <button className="secondary-button" type="button" onClick={props.onCopyLink}>نسخ رابط الدعوة</button>
        <button className="secondary-button quiet" type="button" onClick={props.onCopyCode}>نسخ الرمز</button>
        <button className="secondary-button quiet" type="button" onClick={props.onShare}>مشاركة ↗</button>
        {props.shareNotice && <span className="share-notice" role="status">{props.shareNotice}</span>}
      </div>
      <div className="lobby-table-scene">
        <div className="scene-heading-copy"><span className="section-kicker">المشهد الحي</span><h2>كل وريث له مقعد وصوت ونظرة</h2><p>اختبروا الطاولة قبل بدء الجولة؛ الشخصيات تلتفت وتتحرك معكم.</p></div>
        <Suspense fallback={<div className="table-scene-loading">يُجهّز المجلس...</div>}>
          <TableScene players={props.tableSeats} localPlayerId={props.currentPlayer?.playerId} poses={props.poses} onPose={props.onPose} interactive />
        </Suspense>
      </div>
      <div className="lobby-columns">
        <section className="paper-panel seats-panel">
          <div className="section-heading"><div><span className="section-kicker">المقاعد</span><h2>أهل المجلس <small>{props.room.players.length}/12</small></h2></div><span className="seat-count">{props.room.players.filter((player) => player.ready).length} مستعدون</span></div>
          <ul className="player-list">
            {props.room.players.map((player) => (
              <li key={player.playerId} className="player-row">
                <span className={`seat-number ${player.connected ? "" : "offline"}`} aria-label={player.connected ? "متصل" : "غير متصل"}>{String(player.seatIndex + 1).padStart(2, "0")}</span>
                <span className="player-name">{player.displayName}{player.playerId === props.currentPlayer?.playerId && <small>أنت</small>}</span>
                <span className={`player-role ${player.isHost ? "host-role" : ""}`}>{player.isHost ? "مضيف" : player.ready ? "مستعد" : "ينتظر"}</span>
              </li>
            ))}
            {Array.from({ length: Math.max(0, Math.min(3, 4 - props.room.players.length)) }, (_, index) => (
              <li key={`empty-${index}`} className="player-row empty-seat"><span className="seat-number">··</span><span>مقعد شاغر</span><span className="player-role">بانتظار الدعوة</span></li>
            ))}
          </ul>
        </section>
        <aside className="lobby-side">
          <section className="settings-card">
            <div className="section-heading"><div><span className="section-kicker">إعدادات الملف</span><h2>قواعد المجلس</h2></div><span className="settings-lock">{isHost ? "قابل للتعديل" : "للمضيف"}</span></div>
            <label className="setting-line"><span>نمط اللعب</span><select value="free-for-all" disabled={!isHost} onChange={() => undefined} aria-label="نمط اللعب"><option value="free-for-all">كل وريث لنفسه</option><option value="teams" disabled>فرق متساوية · قريباً</option></select></label>
            <label className="setting-line"><span>عدد الجولات</span><select value={props.room.settings.roundLimit} disabled={!isHost} onChange={(event) => props.onUpdateSettings({ roundLimit: Number(event.target.value) })} aria-label="عدد الجولات"><option value={6}>٦ جولات</option><option value={7}>٦ + جولة أخيرة محتملة</option></select></label>
            <p className="settings-note">يستطيع المضيف بدء اللعبة بعد استعداد ٣ لاعبين على الأقل.</p>
          </section>
          <div className="ready-actions">
            <button className={`secondary-button ready-button ${props.currentPlayer?.ready ? "is-ready" : ""}`} type="button" onClick={props.onReady}>{props.currentPlayer?.ready ? "✓ مستعد للعب" : "أنا مستعد"}</button>
            {isHost && <button className="primary-button" type="button" onClick={props.onStart} disabled={!allReady}>ابدأ المباراة <span aria-hidden="true">↗</span></button>}
            {!isHost && <p className="waiting-copy">عندما يستعد الجميع، يبدأ المضيف المباراة.</p>}
          </div>
        </aside>
      </div>
      <div className="room-notice"><span aria-hidden="true">⌁</span><p>رمز الغرفة للعثور على الطاولة فقط. لكل مقعد رمز استعادة خاص لا يظهر لبقية اللاعبين.</p></div>
    </section>
  );
}

function GameRoom(props: {
  room: RoomView;
  game: GameView;
  tableSeats: TableSeat[];
  tablePoses: Record<string, TablePose>;
  onTablePose: (change: TablePoseChange) => void;
  privateState: PrivateView | null;
  currentPlayer: RoomPlayerView | undefined;
  busy: boolean;
  declarationLot: string;
  setDeclarationLot: (value: string) => void;
  alternateDeclarationLot: string;
  setAlternateDeclarationLot: (value: string) => void;
  declarationBand: "0-1" | "2-3" | "";
  setDeclarationBand: (value: "0-1" | "2-3" | "") => void;
  selectedCardId: number | "";
  setSelectedCardId: (value: number | "") => void;
  cardTargetId: string;
  setCardTargetId: (value: string) => void;
  cardTargetLotId: string;
  setCardTargetLotId: (value: string) => void;
  renegotiationLot: string;
  setRenegotiationLot: (value: string) => void;
  hiddenDeclarationField: "targetLotId" | "bidBand" | "";
  setHiddenDeclarationField: (value: "targetLotId" | "bidBand" | "") => void;
  wagerTarget: string;
  setWagerTarget: (value: string) => void;
  wagerLot: string;
  setWagerLot: (value: string) => void;
  finalLot: string;
  setFinalLot: (value: string) => void;
  baseBid: number;
  setBaseBid: (value: number) => void;
  stanceKind: "pass" | "trust" | "doubt";
  setStanceKind: (value: "pass" | "trust" | "doubt") => void;
  stanceTarget: string;
  setStanceTarget: (value: string) => void;
  onGameAction: (event: string, payload: Record<string, unknown>) => Promise<unknown>;
  onNextRound: () => void;
  chatMessages: RoomMessage[];
  chatDraft: string;
  setChatDraft: (value: string) => void;
  onChat: () => void;
}) {
  const game = props.game;
  const me = game.players.find((player) => player.playerId === props.currentPlayer?.playerId);
  const privateGame = props.privateState?.game;
  const hand = privateGame?.hand ?? [];
  const cardNames = new Map<number, string>(CARD_SOURCE.map((card) => [card.id, PLAYABLE_CARDS.get(card.id)?.name ?? card.name]));
  const locked = game.phase === "declaration" ? me?.declarationLocked : game.phase === "wager-commit" ? privateGame?.wagersLocked : game.phase === "final-action" ? me?.actionLocked : false;
  const results = [...game.events].reverse().find((item) => item.type === "round-resolved")?.payload as Record<string, unknown> | undefined;
  const scoreOrder = [...game.players].sort((a, b) => finalScore(b.seals, b.wagerScore) - finalScore(a.seals, a.wagerScore) || b.seals - a.seals || b.influence - a.influence);
  const targetPlayers = game.players.filter((player) => player.playerId !== props.currentPlayer?.playerId);
  const bidCap = Math.max(0, Math.min(3, (me?.influence ?? 0) - (privateGame?.lockedCardId === 3 ? 1 : 0)));
  const canRenegotiate = privateGame?.lockedCardId === 11 && !me?.declarationChange && Boolean(me?.declaration?.targetLotId)
    && ((game.phase === "negotiation" && !me?.ready) || (game.phase === "final-action" && !me?.actionLocked));
  const renegotiationControl = canRenegotiate ? <div className="card-effect-copy">
    <label>إعادة إعلان القطعة مقابل ١ نفوذ<select value={props.renegotiationLot} onChange={(event) => props.setRenegotiationLot(event.target.value)}>
      <option value="">اختر قطعة مختلفة</option>{game.lots.filter((lot) => lot.id !== me?.declaration?.targetLotId).map((lot) => <option key={lot.id} value={lot.id}>{lot.nameAr} · {lot.id}</option>)}
    </select></label>
    <button className="secondary-button" type="button" disabled={props.busy || !props.renegotiationLot} onClick={() => {
      void props.onGameAction("RENEGOTIATE_DECLARATION", { targetLotId: props.renegotiationLot });
      props.setRenegotiationLot("");
    }}>ادفع وغيّر الإعلان</button>
  </div> : null;

  const submitDeclaration = (event: FormEvent) => {
    event.preventDefault();
    const declaration: Record<string, unknown> = {};
    if (props.declarationLot) declaration.targetLotId = props.declarationLot;
    if (props.selectedCardId === 16 && props.alternateDeclarationLot) declaration.alternateLotId = props.alternateDeclarationLot;
    if (props.declarationBand) declaration.bidBand = props.declarationBand;
    if (props.selectedCardId === 23 && props.hiddenDeclarationField) declaration.hiddenField = props.hiddenDeclarationField;
    void props.onGameAction("SUBMIT_DECLARATION", {
      declaration,
      ...(props.selectedCardId === "" ? {} : { cardId: props.selectedCardId }),
      ...(props.selectedCardId === 37 && props.cardTargetLotId ? { cardParameters: { targetLotId: props.cardTargetLotId } } : {}),
    });
    props.setSelectedCardId("");
    props.setCardTargetId("");
    props.setAlternateDeclarationLot("");
    props.setHiddenDeclarationField("");
    props.setCardTargetLotId("");
  };

  const submitWager = (event: FormEvent) => {
    event.preventDefault();
    if (!props.wagerTarget || !props.wagerLot) {
      void props.onGameAction("SUBMIT_WAGERS", { wagers: [] });
      return;
    }
    void props.onGameAction("SUBMIT_WAGERS", { wagers: [{ targetPlayerId: props.wagerTarget, type: "read", predicate: { kind: "final-lot", lotId: props.wagerLot }, secondWager: false }] });
  };

  const submitAction = (event: FormEvent) => {
    event.preventDefault();
    const stance = props.stanceKind === "pass" ? { kind: "pass" } : { kind: props.stanceKind, targetPlayerId: props.stanceTarget };
    void props.onGameAction("SUBMIT_FINAL_ACTION", { action: { ...(props.finalLot ? { lotId: props.finalLot } : {}), baseBid: props.finalLot ? props.baseBid : 0, stance } });
  };

  return (
    <section className="game-shell">
      <div className="game-header">
        <div><p className="eyebrow">غرفة {props.room.roomCode} · جولة {game.roundIndex} من {game.roundLimit}</p><h1>{phaseLabel(game.phase)}</h1><p>اختياراتك خاصة حتى ينتهي الجميع من القفل.</p></div>
        <div className="scandal-meter"><span>مؤشر الفضيحة</span><strong>{game.scandal}<small>/8</small></strong><div className="meter-track"><i style={{ width: `${(game.scandal / 8) * 100}%` }} /></div>{game.finalRoundMarked && <small>الجولة التالية نهائية</small>}</div>
      </div>
      <div className="game-layout">
        <div className="game-main-column">
          <section className="table-play-area">
            <div className="scene-heading-copy"><span className="section-kicker">مجلس الورثة · جولة {game.roundIndex}</span><h2>انظر إلى من حولك قبل أن تتكلم</h2></div>
            <Suspense fallback={<div className="table-scene-loading">يُجهّز المجلس...</div>}>
              <TableScene
                players={props.tableSeats}
                lots={game.lots}
                localPlayerId={props.privateState?.playerId}
                localHand={props.privateState?.game?.hand ?? []}
                poses={props.tablePoses}
                onPose={props.onTablePose}
                interactive
              />
            </Suspense>
          </section>
          <section className="lot-grid" aria-label="قطع الجولة">
            {game.lots.map((lot) => <article className={`lot-card ${lot.status !== "open" ? "lot-settled" : ""}`} key={lot.id}>
              <div className="lot-label"><span>القطعة {lot.id}</span><span className="lot-seal" aria-hidden="true">✦</span></div>
              <h2>{lot.nameAr}</h2>
              <p className="lot-reward"><span>المكافأة</span>{rewardLabel(lot)}</p>
              {lot.status === "won" && <small>فاز بها {game.players.find((player) => player.playerId === lot.winnerPlayerId)?.displayName}</small>}
              {lot.status === "unclaimed" && <small>بقيت بلا مزايدة</small>}
            </article>)}
          </section>

          {["wager-commit", "negotiation", "final-action", "resolution"].includes(game.phase) && <section className="announcement-panel" aria-label="الإعلانات العلنية">
            <h2>إعلانات الورثة</h2>
            <ul>{game.players.map((player) => {
              const declaration = player.declaration;
              const announcedLot = declaration?.targetLotId ? game.lots.find((lot) => lot.id === declaration.targetLotId)?.nameAr : undefined;
              const alternateLot = declaration?.alternateLotId ? game.lots.find((lot) => lot.id === declaration.alternateLotId)?.nameAr : undefined;
              const stance = declaration?.stance ? `${declaration.stance.kind === "trust" ? "ثقة تجاه" : "شك تجاه"} ${game.players.find((target) => target.playerId === declaration.stance?.targetPlayerId)?.displayName ?? "لاعب"}` : undefined;
              const details = [announcedLot, alternateLot ? `أو ${alternateLot}` : undefined, declaration?.bidBand ? `نطاق ${declaration.bidBand}` : undefined, stance].filter(Boolean).join(" · ");
              const changed = player.declarationChange ? `تغيير مدفوع: ${game.lots.find((lot) => lot.id === player.declarationChange?.fromLotId)?.nameAr ?? player.declarationChange.fromLotId} ← ${game.lots.find((lot) => lot.id === player.declarationChange?.toLotId)?.nameAr ?? player.declarationChange.toLotId}` : undefined;
              return <li key={player.playerId}><b>{player.displayName}</b><span>{player.declarationMasked ? "الإعلان مخفي حتى يقفل الجميع توقعاتهم" : [details || "لا إعلان علني", changed].filter(Boolean).join(" · ")}{player.oneDeclarationFieldHidden && <small> · حقل واحد محجوب</small>}</span></li>;
            })}</ul>
          </section>}

          <section className="phase-card paper-panel">
            {game.phase === "declaration" && <>
              <div className="phase-intro"><span className="phase-step">١</span><div><span className="section-kicker">إعلان علني · غير ملزم</span><h2>أين تتوقع أن تزايد؟</h2><p>هذا الإعلان لا يقيّد اختيارك النهائي، ولا يفرض عليك عقوبة إذا غيّرته.</p></div></div>
              {locked ? <LockedNotice>تم قفل إعلانك. بانتظار بقية الورثة.</LockedNotice> : <form onSubmit={submitDeclaration} className="decision-form">
                <label>القطعة التي تعلنها<select value={props.declarationLot} onChange={(event) => props.setDeclarationLot(event.target.value)}><option value="">لا إعلان</option>{game.lots.map((lot) => <option key={lot.id} value={lot.id}>{lot.nameAr} · {lot.id}</option>)}</select></label>
                <label>بطاقة هذه الجولة<select value={props.selectedCardId} onChange={(event) => { const value = event.target.value; props.setSelectedCardId(value ? Number(value) : ""); }}><option value="">بدون بطاقة</option>{hand.map((id) => <option key={id} value={id} disabled={!PLAYABLE_CARDS.has(id)}>{String(id).padStart(2, "0")} · {PLAYABLE_CARDS.get(id)?.name ?? cardNames.get(id)}{PLAYABLE_CARDS.has(id) ? "" : " · قيد التنفيذ"}</option>)}</select></label>
                {props.selectedCardId !== "" && <p className="card-effect-copy">{PLAYABLE_CARDS.get(props.selectedCardId)?.effect ?? "هذه البطاقة لم تُفعّل بعد."}</p>}
                {props.selectedCardId === 16 && <label>الإعلان عن قطعة ثانية<select value={props.alternateDeclarationLot} onChange={(event) => props.setAlternateDeclarationLot(event.target.value)}><option value="">اختر قطعة مختلفة</option>{game.lots.filter((lot) => lot.id !== props.declarationLot).map((lot) => <option key={lot.id} value={lot.id}>{lot.nameAr} · {lot.id}</option>)}</select></label>}
                {props.selectedCardId === 37 && <label>القطعة التي يطالها الشرط<select value={props.cardTargetLotId} onChange={(event) => props.setCardTargetLotId(event.target.value)}><option value="">اختر قطعة</option>{game.lots.map((lot) => <option key={lot.id} value={lot.id}>{lot.nameAr} · {lot.id}</option>)}</select></label>}
                {props.selectedCardId === 23 && <label>الحقل الذي تحجبه<select value={props.hiddenDeclarationField} onChange={(event) => props.setHiddenDeclarationField(event.target.value as "targetLotId" | "bidBand" | "")}>{props.declarationLot && <option value="targetLotId">القطعة المعلنة</option>}{props.declarationBand && <option value="bidBand">نطاق العرض</option>}<option value="">اختر حقلاً معلناً</option></select></label>}
                <label>نطاق عرضك المتوقع<select value={props.declarationBand} onChange={(event) => props.setDeclarationBand(event.target.value as "0-1" | "2-3" | "")}><option value="">بدون تحديد</option><option value="0-1">من ٠ إلى ١</option><option value="2-3">من ٢ إلى ٣</option></select></label>
                <button className="primary-button" type="submit" disabled={props.busy || (props.selectedCardId === 16 && (!props.declarationLot || !props.alternateDeclarationLot)) || (props.selectedCardId === 23 && (!props.hiddenDeclarationField || (props.hiddenDeclarationField === "targetLotId" && !props.declarationLot) || (props.hiddenDeclarationField === "bidBand" && !props.declarationBand))) || (props.selectedCardId === 37 && !props.cardTargetLotId)}>اقفل الإعلان <span aria-hidden="true">↗</span></button>
              </form>}
            </>}

            {game.phase === "wager-commit" && <>
              <div className="phase-intro"><span className="phase-step">٢</span><div><span className="section-kicker">سرّي حتى التسوية</span><h2>هل ستتوقع اختيار وريث؟</h2><p>التوقع الصحيح يمنحك +٢ نقطة، والخاطئ يخصم ٣ نقاط. يمكنك المرور بلا خسارة.</p></div></div>
              {locked ? <LockedNotice>تم قفل توقعك. لن يراه أحد قبل التسوية.</LockedNotice> : <form onSubmit={submitWager} className="decision-form">
                <label>الوريث المستهدف<select value={props.wagerTarget} onChange={(event) => props.setWagerTarget(event.target.value)}><option value="">مرور بلا توقع</option>{targetPlayers.map((player) => <option key={player.playerId} value={player.playerId}>{player.displayName}</option>)}</select></label>
                <label>توقّع اختياره<select value={props.wagerLot} onChange={(event) => props.setWagerLot(event.target.value)}><option value="">اختر قطعة</option>{game.lots.map((lot) => <option key={lot.id} value={lot.id}>{lot.nameAr}</option>)}</select></label>
                <button className="primary-button" type="submit" disabled={props.busy}>{props.wagerTarget && props.wagerLot ? "اقفل التوقع" : "مرور بلا توقع"}<span aria-hidden="true">↗</span></button>
              </form>}
            </>}

            {game.phase === "negotiation" && <>
              <div className="phase-intro"><span className="phase-step">٣</span><div><span className="section-kicker">وقت التفاوض · {props.room.settings.negotiationSeconds} ثانية</span><h2>الطاولة مفتوحة للكلام</h2><p>الوعود الشفهية لا تُنشئ التزاماً. يمكنك الصمت أو إنهاء تفاوضك في أي وقت.</p></div></div>
              {me?.ready ? <LockedNotice>أنهيت تفاوضك. بانتظار الآخرين.</LockedNotice> : <>
                {renegotiationControl}
                {[8, 12, 21, 25, 26, 31].includes(privateGame?.lockedCardId ?? 0) && <label className="negotiation-target">اختر لاعباً للبطاقة<select value={props.cardTargetId} onChange={(event) => props.setCardTargetId(event.target.value)}><option value="">تمرير البطاقة بلا هدف</option>{targetPlayers.map((player) => <option key={player.playerId} value={player.playerId}>{player.displayName}</option>)}</select></label>}
                <button className="primary-button" type="button" onClick={() => { void props.onGameAction("FINISH_NEGOTIATION", props.cardTargetId ? { cardParameters: { targetPlayerId: props.cardTargetId } } : {}); props.setCardTargetId(""); }}>انتهيت من التفاوض <span aria-hidden="true">↗</span></button>
              </>}
            </>}

            {game.phase === "final-action" && <>
              <div className="phase-intro"><span className="phase-step">٤</span><div><span className="section-kicker">اختيار سري · عرض من ٠ إلى ٣</span><h2>وقّع اختيارك الأخير</h2><p>اختر قطعة أو مرّ. كل مزايد يدفع عرضه الأساسي حتى لو لم يفز.</p></div></div>
              {locked ? <LockedNotice>قُفل اختيارك النهائي. لن يظهر قبل قفل الجميع.</LockedNotice> : <form onSubmit={submitAction} className="decision-form">
                {renegotiationControl}
                <label>القطعة<select value={props.finalLot} onChange={(event) => { props.setFinalLot(event.target.value); if (!event.target.value) props.setBaseBid(0); }}><option value="">مرور بلا مزايدة</option>{game.lots.map((lot) => <option key={lot.id} value={lot.id}>{lot.nameAr} · {lot.id}</option>)}</select></label>
                <label>عرضك الأساسي <b>{props.finalLot ? props.baseBid : 0}</b><input type="range" min="0" max={bidCap} value={props.finalLot ? Math.min(props.baseBid, bidCap) : 0} disabled={!props.finalLot || bidCap === 0} onChange={(event) => props.setBaseBid(Number(event.target.value))} /><span className="range-ends"><small>٠</small><small>{bidCap} · المتاح بعد كلفة البطاقة</small></span></label>
                <label>موقفك تجاه لاعب<select value={props.stanceKind} onChange={(event) => props.setStanceKind(event.target.value as "pass" | "trust" | "doubt")}><option value="pass">مرور · بلا أثر</option><option value="trust">ثقة · +١ للهدف إن تنافستما على القطعة نفسها</option><option value="doubt">شك · +١ في مسار الشك</option></select></label>
                {props.stanceKind !== "pass" && <label>اللاعب المستهدف<select required value={props.stanceTarget} onChange={(event) => props.setStanceTarget(event.target.value)}><option value="">اختر لاعباً</option>{targetPlayers.map((player) => <option key={player.playerId} value={player.playerId}>{player.displayName}</option>)}</select></label>}
                <button className="primary-button" type="submit" disabled={props.busy || (props.stanceKind !== "pass" && !props.stanceTarget)}>اقفل الاختيار <span aria-hidden="true">↗</span></button>
              </form>}
            </>}

            {game.phase === "resolution" && <LockedNotice>كُشفت الاختيارات. يجري الخادم حسم المزايدات والتسوية.</LockedNotice>}

            {(game.phase === "round-summary" || game.phase === "complete") && <>
              <div className="phase-intro"><span className="phase-step">✦</span><div><span className="section-kicker">النتيجة الموثقة</span><h2>{game.phase === "complete" ? "أُغلق ملف الميراث" : `انتهت الجولة ${game.roundIndex}`}</h2><p>الأختام تساوي ٤ نقاط لكل ختم. ثم تُضاف نقاط التوقعات.</p></div></div>
              {results && <RoundResult results={results} players={game.players} />}
              <Standings players={scoreOrder} />
              {game.phase === "round-summary" && props.currentPlayer?.isHost && <button className="primary-button next-round-button" type="button" onClick={props.onNextRound}>ابدأ الجولة التالية <span aria-hidden="true">↗</span></button>}
              {game.phase === "complete" && <p className="winner-callout">{scoreOrder[0]?.displayName} يتصدر السجل برصيد {scoreOrder[0] ? finalScore(scoreOrder[0].seals, scoreOrder[0].wagerScore) : 0} نقطة.</p>}
            </>}
          </section>
        </div>

        <aside className="game-side-column">
          <section className="player-panel">
            <div className="section-heading"><div><span className="section-kicker">المجلس</span><h2>الأرصدة العامة</h2></div><span className="table-icon">⌂</span></div>
            <ul className="score-list">{scoreOrder.map((player) => <li key={player.playerId} className={player.playerId === props.currentPlayer?.playerId ? "is-you" : ""}>
              <span className="score-seat">{String(player.seatIndex + 1).padStart(2, "0")}</span><span className="score-name">{player.displayName}{player.playerId === props.currentPlayer?.playerId && <small>أنت</small>}</span><span className="score-resources"><b title="الأختام">✦ {player.seals}</b><b title="النفوذ">◈ {player.influence}</b></span>
              <span className="score-tracks">الشك {player.suspicion}/3 <span>·</span> توقعات {player.wagerScore >= 0 ? "+" : ""}{player.wagerScore}</span>
            </li>)}</ul>
          </section>

      <section className="hand-panel">
            <div className="section-heading"><div><span className="section-kicker">خاص بك وحدك</span><h2>بطاقاتك <small>{hand.length}</small></h2></div><span className="lock-icon" aria-label="محتوى خاص">▣</span></div>
            <div className="hand-list">{hand.map((id) => <div className="hand-card" key={id}><span className="card-number">{String(id).padStart(2, "0")}</span><span>{cardNames.get(id) ?? "بطاقة"}</span><small>{PLAYABLE_CARDS.has(id) ? "متاحة للعب" : "مؤثرها قيد التنفيذ"}</small></div>)}{hand.length === 0 && <p className="muted-copy">لا توجد بطاقة في يدك الآن.</p>}</div>
            <p className="private-note">المؤثرات المتاحة: ١، ٣–٦، ٨، ١٠–١٦، ١٨، ٢١–٢٣، ٢٥، ٢٦، ٣١، ٣٢، ٣٥، ٣٧، ٤٠، ٤٣، ٤٧، ٤٨، ٥٤، ٥٦. بقية البطاقات لا تُستهلك لأنها ما زالت قيد التنفيذ.</p>
          </section>

          {props.room.settings.chatEnabled && <section className="chat-panel">
            <div className="section-heading"><div><span className="section-kicker">دردشة عامة · لا تُحفظ</span><h2>حديث المجلس</h2></div></div>
            <ul className="chat-messages" aria-live="polite">{props.chatMessages.map((message, index) => <li key={`${message.playerId}-${index}`}><b>{message.displayName}</b><span>{message.message}</span></li>)}</ul>
            <form className="chat-form" onSubmit={(event) => { event.preventDefault(); props.onChat(); }}><label className="sr-only" htmlFor="chat-input">رسالة عامة</label><input id="chat-input" maxLength={500} value={props.chatDraft} onChange={(event) => props.setChatDraft(event.target.value)} placeholder="رسالة للجميع" /><button type="submit" aria-label="إرسال الرسالة">↗</button></form>
          </section>}
        </aside>
      </div>
    </section>
  );
}

function LockedNotice({ children }: { children: string }) {
  return <div className="locked-notice" role="status"><span aria-hidden="true">▣</span>{children}</div>;
}

function Standings({ players }: { players: GamePlayerView[] }) {
  return <div className="standings-table"><div className="standings-head"><span>الوريث</span><span>الأختام</span><span>التوقع</span><span>المجموع</span></div>{players.map((player, index) => <div className="standings-row" key={player.playerId}><span><b>{index + 1}.</b> {player.displayName}</span><span>{player.seals}</span><span>{player.wagerScore >= 0 ? "+" : ""}{player.wagerScore}</span><strong>{finalScore(player.seals, player.wagerScore)}</strong></div>)}</div>;
}

function RoundResult({ results, players }: { results: Record<string, unknown>; players: GamePlayerView[] }) {
  const lots = Array.isArray(results.lots) ? results.lots as LotView[] : [];
  const auctions = Array.isArray(results.lotResults) ? results.lotResults as Array<{ lotId: string; winnerPlayerId?: string; tiedPlayerIds: string[]; bidResolutions: Array<{ playerId: string; baseBid: number; effectiveBid: number; won: boolean; calculation: string[] }> }> : [];
  const wagers = Array.isArray(results.wagers) ? results.wagers as Array<{ bettorPlayerId: string; targetPlayerId: string; predicate: unknown; result: boolean | "void"; delta: number }> : [];
  return <div className="round-result">
    <h3>المزايدات</h3>
    {auctions.map((auction) => <article className="audit-lot" key={auction.lotId}><b>القطعة {auction.lotId}</b><span>{auction.winnerPlayerId ? `الفائز: ${players.find((player) => player.playerId === auction.winnerPlayerId)?.displayName}` : auction.tiedPlayerIds.length ? "تعادل بلا فائز" : "بلا مزايد"}</span>{auction.bidResolutions.map((bid) => <small key={bid.playerId}>{players.find((player) => player.playerId === bid.playerId)?.displayName}: أساس {bid.baseBid} ← {bid.effectiveBid}{bid.won ? " · فاز" : ""}</small>)}</article>)}
    <h3>المكافآت والتوقعات</h3>
    <p>{lots.filter((lot) => lot.winnerPlayerId).map((lot) => `${players.find((player) => player.playerId === lot.winnerPlayerId)?.displayName}: ${rewardLabel(lot)}`).join(" · ") || "لم يحصل أحد على قطعة هذه الجولة."}</p>
    {wagers.map((wager, index) => <small className="audit-wager" key={index}>توقع {players.find((player) => player.playerId === wager.bettorPlayerId)?.displayName} على {players.find((player) => player.playerId === wager.targetPlayerId)?.displayName}: {wager.result === "void" ? "ملغى" : wager.result ? `صحيح +${wager.delta}` : `غير صحيح ${wager.delta}`}</small>)}
  </div>;
}
