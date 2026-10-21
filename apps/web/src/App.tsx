import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { io, type Socket } from "socket.io-client";
import { CARD_SOURCE, DEFAULT_STORY_ID, finalScore, getStory, STORY_CATALOG } from "@akher-tawqee/game-engine";
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
  declaration?: { targetLotId?: string; alternateLotId?: string; bidBand?: "0-1" | "2-3"; stance?: { kind: "trust" | "doubt"; targetPlayerId: string }; illusionStance?: "trust" | "doubt" };
  declarationMasked?: boolean;
  oneDeclarationFieldHidden?: boolean;
  declarationChange?: { fromLotId: string; toLotId: string };
  actionLocked: boolean;
  action?: { lotId?: string; baseBid: number };
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
  formalContract?: { proposerPlayerId: string; targetPlayerId: string; condition: { kind: string; playerId?: string; lotId?: string; fromPlayerId?: string; toPlayerId?: string; amount?: number }; status: string };
  pendingPressureEffects?: Array<{ sourcePlayerId: string; targetPlayerId: string; sourceCardId: number; kind: "influence" | "suspicion"; amount: number; dueRoundIndex: number }>;
};

type RoomView = {
  roomCode: string;
  status: "lobby" | "playing" | "complete";
  version: number;
  hostPlayerId: string;
  settings: { mode: string; roundLimit: number; chatEnabled: boolean; negotiationSeconds: number; storyId?: string };
  players: RoomPlayerView[];
  game?: GameView;
};

type PrivateView = {
  playerId: string;
  game?: { hand: number[]; lockedCardId?: number; cardParameters?: Record<string, string | number | boolean>; declaration?: unknown; wagers?: unknown[]; action?: unknown; wagersLocked?: boolean; cardPrompts?: Array<{ sourcePlayerId: string; sourceName: string; cardId: number; effectCardId?: number }>; nextRoundLotChoices?: Array<{ id: string; nameAr: string }>; contractPrompt?: GameView["formalContract"] };
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
  [1, { name: "إعلان عالماشي", effect: "لو كسبت نفس المكان اللي أعلنته، عرضك يزيد نقطة." }],
  [2, { name: "عقد مش كلام", effect: "قدّم للاعب عقد بشرط واضح من اللعبة. لو وافق، كل واحد يحط نفوذ أمان؛ والوفاء يرجّعه ويكافئكم." }],
  [3, { name: "زقّة محسوبة", effect: "ادفع نفوذ زيادة عشان تزود عرضك الفعلي نقطتين، لحد ٦." }],
  [4, { name: "شبكة أمان", effect: "لو زايدت وخسرت، يرجعلك نقطة نفوذ من اللي دفعته." }],
  [5, { name: "نص التمن", effect: "لو كسبت بعرض أساسي ٢ أو ٣، يرجعلك نفوذ واحد بعد ما الفايز يتحدد." }],
  [6, { name: "وسيط الثقة", effect: "لو حد وثق فيك وإنتوا على نفس القطعة، عرضك يزيد نقطة." }],
  [7, { name: "دين قديم", effect: "لو لاعب نقض عقد معاك الجولة اللي فاتت، عرضك يزيد نقطة لو نافستوا على نفس القطعة." }],
  [8, { name: "عمولة السمسار", effect: "اختار لاعب. لو كل واحد فيكم اختار قطعة مختلفة، كل واحد يكسب نفوذ." }],
  [9, { name: "مفتاح التعادل", effect: "لو فضلت متعادل بعد قاعدة الأختام، ومن أختامك أقل، ادفع نفوذ عشان تكسب التعادل. غير كده ملوش تأثير." }],
  [10, { name: "سلفة العيلة", effect: "تاخد نفوذ دلوقتي. لو كسبت، تسدد نقطتين؛ لو ماكسبتش، الشك عندك يزيد." }],
  [11, { name: "إعادة تفاوض", effect: "قبل ما تقفل اختيارك، ادفع نفوذ وغيّر إعلانك. الإعلان القديم يفضل هو مرجع التوقعات." }],
  [12, { name: "رغبة مشتركة", effect: "اختار لاعب. لو كل واحد فيكم راح لقطعة مختلفة، كل واحد ياخد نفوذ." }],
  [13, { name: "عمولة المزاد", effect: "لو كسبت قطعة كان عليها متنافسين حقيقيين بالظبط، تكسب نفوذ." }],
  [14, { name: "آخر جنيه", effect: "لو عرضك أقل من أعلى عرض بنقطة واحدة، ادفع نفوذ وزوّده نقطة." }],
  [15, { name: "الزحمة ليها مكسب", effect: "كسبان أكتر قطعة زحمة ياخد نفوذ. لو كسبت الأقل زحمة، الشك عندك يقل." }],
  [16, { name: "طريقين", effect: "أعلن عن قطعتين. لو اخترت الأقل زحمة فيهم، عرضك يزيد نقطة." }],
  [17, { name: "ظرف فاضي", effect: "حط علامة منافس وهمي على قطعة. ماتحسبش كمزايد حقيقي ومش بيكسب ختم." }],
  [18, { name: "نية متغطية", effect: "إعلانك يفضل مخفي لحد ما الكل يقفل توقعاته، وبعدها يظهر." }],
  [19, { name: "حوّل الطريق", effect: "لو أعلنت عن قطعتين، وجّه اختيارك للأقل زحمة فيهم. عرضك يقل نقطة." }],
  [20, { name: "مراية الخصم", effect: "اختار منافس على نفس القطعة وانسخ نقطة واحدة من تعديل عرضه لو كارت لعبه عدّله." }],
  [21, { name: "إشاعة محسوبة", effect: "اختار لاعب. لو غيّر إعلانه تكسب نفوذ؛ لو التزم بيه، شكه يزيد." }],
  [22, { name: "حساب معكوس", effect: "لو عرضك طلع عكس النطاق اللي أعلنته، عرضك يزيد نقطة والشك عندك يزيد نقطة." }],
  [23, { name: "قصاصة ناقصة", effect: "اخفي حقل واحد من إعلانك، والكل يعرف إن فيه حقل مستخبي." }],
  [24, { name: "نسخة بديلة", effect: "لو ٣ لاعيبة أو أكتر رايحين لقطعتك، ادفع نفوذ وحوّل للأقل زحمة؛ عرضك يقل نقطة." }],
  [25, { name: "صدى الكلام", effect: "اختار إعلان لاعب وكرره قدام الكل. لو غيّر اختياره، تكسب نفوذ." }],
  [26, { name: "علامة مزيفة", effect: "انقل نقطة شك من عندك للاعب تختاره. الشك مايزيدش عن ٣." }],
  [27, { name: "تعديل آخر لحظة", effect: "ادفع نفوذ واختار: زوّد عرضك أو قلّله نقطة واحدة." }],
  [28, { name: "رتّب الملفّات", effect: "بص على أول ملفّين للجولة الجاية واختار أنهي واحد يطلع الأول." }],
  [29, { name: "ختم وهمي", effect: "أعلن موقف، وورّي علامة عكسه. لو موقفك الأخير خالف إعلانك، الشك عندك يزيد." }],
  [30, { name: "باب جانبي", effect: "لو مش أعلى مزايد على قطعتك، ادفع نفوذ وحوّل لقطعة أقل زحمة. بتتنازل عن القطعة الأولى." }],
  [31, { name: "غرامة التناقض", effect: "اختار لاعب. لو غيّر القطعة اللي أعلنها، شكه يزيد؛ لو ما غيّرش، إنت تدفع نفوذ." }],
  [32, { name: "عقرب الساعة", effect: "الفضيحة تزيد نقطتين، وتتراجع عند نهاية الجولة بس." }],
  [33, { name: "افتح ملف واحد", effect: "لاعب تختاره يختار كارت واحد من إيده ويكشفه للكل لآخر الجولة." }],
  [34, { name: "ضريبة المزاد", effect: "اختار لاعب: لو عرضه ٢ أو ٣ يدفع نفوذ؛ لو ٠ أو ١، الشك عنده يزيد." }],
  [35, { name: "ضغط الزحمة", effect: "لو ٣ لاعيبة على الأقل في أكتر قطعة زحمة، عروضهم تقل نقطة والفضيحة تزيد." }],
  [36, { name: "سمعة وحشة", effect: "اختار لاعب عنده شك بالفعل؛ زوّد شكه نقطة، لحد ٣." }],
  [37, { name: "شرط تقيل", effect: "اختار قطعة. اللي أعلنها يزايد بنقطة على الأقل أو يدفع نفوذ؛ والمرور برضه عليه الكلفة." }],
  [38, { name: "اكشف موقفه", effect: "اختار لاعب. موقف الثقة أو الشك بتاعه يظهر بدري؛ لو عدى، مفيش تأثير." }],
  [39, { name: "رسالة تهديد", effect: "اللاعب يختار: يدفع نفوذ أو يكشف كارت واحد من إيده." }],
  [40, { name: "فاتورة نفوذ", effect: "كل لاعب فاضل معاه ٤ نفوذ أو أكتر يدفع نقطة." }],
  [41, { name: "كشاف على المتصدر", effect: "اختار صاحب أختام كتير وقطعة. عرضه الفعلي على القطعة يقل نقطة." }],
  [42, { name: "تفتيش الخزنة", effect: "اللاعب يختار يدفع نفوذ أو يورّي فئة كارت واحد من غير ما يكشفه." }],
  [43, { name: "فضيحة بتكبر", effect: "زوّد الفضيحة نقطة؛ لو كانت ٦ أو أكتر، زوّد نقطة كمان." }],
  [44, { name: "ضيّق المكسب", effect: "اختار لاعب أختامه أكتر منك. لو كسب قطعة، ياخد الختم بس من غير مكافأتها." }],
  [45, { name: "إنذار أخير", effect: "اللاعب اللي متصدر مزايدة يختار: يدفع نفوذ أو ياخد نقطة شك." }],
  [46, { name: "ختم حماية", effect: "احمِ نفسك أو لاعب من أول كارت سلبي مستهدفه الجولة دي." }],
  [47, { name: "سجل موثّق", effect: "قلّل الشك عندك نقطة. لو معندكش شك، تكسب نفوذ بدلها." }],
  [48, { name: "ضمان الخسران", effect: "لو زايدت وخسرت، يرجعلك نفوذ واحد. مايتجمعش مع كارت ٤." }],
  [49, { name: "انسحاب مرتب", effect: "اسحب مزايدتك، يرجعلك عرضك الأساسي، وماتكسبش القطعة دي الجولة." }],
  [50, { name: "شمسية الوارث", effect: "قلّل نقطة شك واحدة كارت ضغط كان هيضيفها عليك." }],
  [51, { name: "باب خلفي", effect: "امنع أي كارت إنه يغيّر قطعتك الأخيرة. باقي التأثيرات تفضل شغالة." }],
  [52, { name: "رد الضربة", effect: "لو كارت سلبي استهدفك وله مصدر واحد، ارجعه لصاحبه مرة واحدة." }],
  [53, { name: "تأمين الختم", effect: "ادفع نفوذ عشان تمنع خسارة ختم سببها كارت. مش خسارة مزاد." }],
  [54, { name: "صندوق الطوارئ", effect: "لو ماكسبتش قطعة، تكسب نفوذ لحد الحد الأقصى." }],
  [55, { name: "إلغاء التوقيع", effect: "لو عقد اتنقض ضدك، كل واحد يسترد الأمان بتاعه من غير مكافأة وفاء." }],
  [56, { name: "هدنة قصيرة", effect: "قلّل الفضيحة نقطة، بس الشك عندك يزيد نقطة." }],
  [57, { name: "زجاج الحفظ", effect: "احمِ مكافأة قطعة واحدة من السرقة أو التعطيل الجولة دي." }],
  [58, { name: "حساب مؤجل", effect: "أجّل كارت ضغط واحد عليك للجولة الجاية. ساعتها يا تدفع نفوذ عشان تلغيه، يا يتنفذ." }],
  [59, { name: "نجدة متبادلة", effect: "قلّل الشك عن لاعب. لو كان وثق فيك الجولة دي، تكسب نفوذ." }],
  [60, { name: "آخر صفحة", effect: "في الجولة الأخيرة، لو متأخر بختم واحد أو أقل، اختار تزود عرضك نقطة أو تقلّل شكك." }],
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
    declaration: "قول خطتك",
    "wager-commit": "اكتب توقعك",
    negotiation: "التفاوض",
    "final-action": "اختيارك الأخير",
    "card-response": "رد على كارت",
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
  const [declarationStanceKind, setDeclarationStanceKind] = useState<"trust" | "doubt" | "">("");
  const [declarationStanceTarget, setDeclarationStanceTarget] = useState("");
  const [selectedCardId, setSelectedCardId] = useState<number | "">("");
  const [cardTargetId, setCardTargetId] = useState("");
  const [cardTargetLotId, setCardTargetLotId] = useState("");
  const [renegotiationLot, setRenegotiationLot] = useState("");
  const [hiddenDeclarationField, setHiddenDeclarationField] = useState<"targetLotId" | "bidBand" | "stance" | "">("");
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
      showCards: change.showCards ?? previous?.showCards ?? false,
      updatedAt: Date.now(),
    };
    setTablePoses((current) => ({ ...current, [playerId]: pose }));
    socket.emit("TABLE_ACTION", { lookAt: pose.lookAt, gesture: pose.gesture, showCards: pose.showCards });
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
  const storyChapter = game?.phase === "complete" ? "ending"
    : game?.roundIndex === 1 ? "opening"
      : game && game.roundLimit > 1 && game.roundIndex === Math.max(2, Math.ceil(game.roundLimit / 2)) ? "middle"
        : undefined;
  const triggeredStoryKey = game && storyChapter ? `${game.gameId}:${storyChapter}` : "";
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
    const sceneKey = triggeredStoryKey;
    if (!gameId || !sceneKey) return;
    if (seenStoryRef.current === sceneKey) return;
    const storageKey = `akher:story:${sceneKey}`;
    seenStoryRef.current = sceneKey;
    if (sessionStorage.getItem(storageKey)) return;
    sessionStorage.setItem(storageKey, "seen");
    setStorySceneKey(sceneKey);
  }, [game?.gameId, triggeredStoryKey]);

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
              <p className="hero-copy">اقعدوا حوالين ترابيزة الميراث. قولوا ناويين على إيه، حاولوا تتوقعوا بعض، وبعدها ارفعوا عروضكم في آخر لحظة.</p>
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

        {room && room.status !== "lobby" && game && triggeredStoryKey && storySceneKey === triggeredStoryKey && (
          <Suspense fallback={<div className="table-scene-loading story-loading">يُفتح ملفّ العائلة...</div>}>
            <StoryCutscene
              key={storySceneKey}
              story={getStory(room.settings.storyId)}
              chapter={storyChapter!}
              winnerName={game.phase === "complete" ? [...game.players].sort((a, b) => finalScore(b.seals, b.wagerScore) - finalScore(a.seals, a.wagerScore))[0]?.displayName : undefined}
              scandal={game.scandal}
              players={tableSeats}
              lots={game.lots}
              localPlayerId={privateState?.playerId}
              localHand={privateState?.game?.hand ?? []}
              localHandLabels={(privateState?.game?.hand ?? []).map((id) => PLAYABLE_CARDS.get(id)?.name ?? `بطاقة ${id}`)}
              poses={tablePoses}
              onPose={sendTablePose}
              onClose={() => setStorySceneKey("")}
            />
          </Suspense>
        )}

        {room && room.status !== "lobby" && game && (!triggeredStoryKey || storySceneKey !== triggeredStoryKey) && (
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
            declarationStanceKind={declarationStanceKind}
            setDeclarationStanceKind={setDeclarationStanceKind}
            declarationStanceTarget={declarationStanceTarget}
            setDeclarationStanceTarget={setDeclarationStanceTarget}
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
            <label className="setting-line"><span>قصة المباراة</span><select value={props.room.settings.storyId ?? DEFAULT_STORY_ID} disabled={!isHost} onChange={(event) => props.onUpdateSettings({ storyId: event.target.value })} aria-label="قصة المباراة">{STORY_CATALOG.map((story) => <option value={story.id} key={story.id}>{story.title} · {story.genre}</option>)}</select></label>
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
  declarationStanceKind: "trust" | "doubt" | "";
  setDeclarationStanceKind: (value: "trust" | "doubt" | "") => void;
  declarationStanceTarget: string;
  setDeclarationStanceTarget: (value: string) => void;
  selectedCardId: number | "";
  setSelectedCardId: (value: number | "") => void;
  cardTargetId: string;
  setCardTargetId: (value: string) => void;
  cardTargetLotId: string;
  setCardTargetLotId: (value: string) => void;
  renegotiationLot: string;
  setRenegotiationLot: (value: string) => void;
  hiddenDeclarationField: "targetLotId" | "bidBand" | "stance" | "";
  setHiddenDeclarationField: (value: "targetLotId" | "bidBand" | "stance" | "") => void;
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
  const [cardReplyChoices, setCardReplyChoices] = useState<Record<string, string>>({});
  const [cardReplyIds, setCardReplyIds] = useState<Record<string, number | "">>({});
  const [cardDirection, setCardDirection] = useState("up");
  const [lastPageChoice, setLastPageChoice] = useState("bid");
  const [illusionStance, setIllusionStance] = useState<"trust" | "doubt">("trust");
  const [nextRoundFirstLotId, setNextRoundFirstLotId] = useState("");
  const [contractKind, setContractKind] = useState("no-bid");
  const [contractBoundPlayerId, setContractBoundPlayerId] = useState("");
  const [contractLotId, setContractLotId] = useState("");
  const [contractTransferDirection, setContractTransferDirection] = useState("to-target");
  const [contractTransferAmount, setContractTransferAmount] = useState(1);
  const game = props.game;
  const me = game.players.find((player) => player.playerId === props.currentPlayer?.playerId);
  const privateGame = props.privateState?.game;
  const hand = privateGame?.hand ?? [];
  const cardNames = new Map<number, string>(CARD_SOURCE.map((card) => [card.id, PLAYABLE_CARDS.get(card.id)?.name ?? card.name]));
  const locked = game.phase === "declaration" ? me?.declarationLocked : game.phase === "wager-commit" ? privateGame?.wagersLocked : game.phase === "final-action" ? me?.actionLocked : false;
  const results = [...game.events].reverse().find((item) => item.type === "round-resolved")?.payload as Record<string, unknown> | undefined;
  const scoreOrder = [...game.players].sort((a, b) => finalScore(b.seals, b.wagerScore) - finalScore(a.seals, a.wagerScore) || b.seals - a.seals || b.influence - a.influence);
  const targetPlayers = game.players.filter((player) => player.playerId !== props.currentPlayer?.playerId);
  const bidCap = Math.max(0, Math.min(3, (me?.influence ?? 0) - ([3, 24, 27, 30].includes(privateGame?.lockedCardId ?? 0) ? 1 : 0)));
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
    if ([16, 19].includes(Number(props.selectedCardId)) && props.alternateDeclarationLot) declaration.alternateLotId = props.alternateDeclarationLot;
    if (props.declarationBand) declaration.bidBand = props.declarationBand;
    if (props.declarationStanceKind && props.declarationStanceTarget) declaration.stance = { kind: props.declarationStanceKind, targetPlayerId: props.declarationStanceTarget };
    if (props.selectedCardId === 23 && props.hiddenDeclarationField) declaration.hiddenField = props.hiddenDeclarationField;
    if (props.selectedCardId === 29) declaration.illusionStance = illusionStance;
    const cardParameters: Record<string, string | number | boolean> = {};
    if ([17, 37, 57].includes(Number(props.selectedCardId)) && props.cardTargetLotId) cardParameters.targetLotId = props.cardTargetLotId;
    if (props.selectedCardId === 27) cardParameters.direction = cardDirection;
    if (props.selectedCardId === 28 && nextRoundFirstLotId) cardParameters.firstNextLotId = nextRoundFirstLotId;
    if (props.selectedCardId === 60) cardParameters.lastPageChoice = lastPageChoice;
    void props.onGameAction("SUBMIT_DECLARATION", {
      declaration,
      ...(props.selectedCardId === "" ? {} : { cardId: props.selectedCardId }),
      ...(Object.keys(cardParameters).length ? { cardParameters } : {}),
    });
    props.setSelectedCardId("");
    props.setCardTargetId("");
    props.setAlternateDeclarationLot("");
    props.setHiddenDeclarationField("");
    props.setDeclarationStanceKind("");
    props.setDeclarationStanceTarget("");
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

  const submitCardReply = (prompt: { sourcePlayerId: string; cardId: number }) => {
    const key = `${prompt.sourcePlayerId}:${prompt.cardId}`;
    const choice = prompt.cardId === 33 ? "reveal-card" : cardReplyChoices[key];
    if (!choice) return;
    void props.onGameAction("RESPOND_CARD_EFFECT", {
      sourcePlayerId: prompt.sourcePlayerId,
      cardId: prompt.cardId,
      choice,
      ...(typeof cardReplyIds[key] === "number" ? { revealedCardId: cardReplyIds[key] } : {}),
    });
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
            <div className="scene-heading-copy"><span className="section-kicker">مجلس الورثة · جولة {game.roundIndex}</span><h2>بص للي حواليك قبل ما تتكلم</h2></div>
            <Suspense fallback={<div className="table-scene-loading">يُجهّز المجلس...</div>}>
              <TableScene
                players={props.tableSeats}
                lots={game.lots}
                localPlayerId={props.privateState?.playerId}
                localHand={props.privateState?.game?.hand ?? []}
                localHandLabels={hand.map((id) => PLAYABLE_CARDS.get(id)?.name ?? `بطاقة ${id}`)}
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
              const illusion = declaration?.illusionStance ? `علامة ${declaration.illusionStance === "trust" ? "ثقة" : "شك"}، وظلّها العكسي ظاهر` : undefined;
              const details = [announcedLot, alternateLot ? `أو ${alternateLot}` : undefined, declaration?.bidBand ? `نطاق ${declaration.bidBand}` : undefined, stance, illusion].filter(Boolean).join(" · ");
              const changed = player.declarationChange ? `تغيير مدفوع: ${game.lots.find((lot) => lot.id === player.declarationChange?.fromLotId)?.nameAr ?? player.declarationChange.fromLotId} ← ${game.lots.find((lot) => lot.id === player.declarationChange?.toLotId)?.nameAr ?? player.declarationChange.toLotId}` : undefined;
              return <li key={player.playerId}><b>{player.displayName}</b><span>{player.declarationMasked ? "الإعلان مخفي حتى يقفل الجميع توقعاتهم" : [details || "لا إعلان علني", changed].filter(Boolean).join(" · ")}{player.oneDeclarationFieldHidden && <small> · حقل واحد محجوب</small>}</span></li>;
            })}</ul>
          </section>}

          <section className="phase-card paper-panel">
            {game.phase === "declaration" && <>
              <div className="phase-intro"><span className="phase-step">١</span><div><span className="section-kicker">إعلان علني · مش ملزمك</span><h2>هتزايد على أنهي قطعة؟</h2><p>قول اللي في دماغك، وبعدها اختار براحتك. مفيش عقوبة لو غيّرت رأيك.</p></div></div>
              {locked ? <LockedNotice>تم قفل إعلانك. بانتظار بقية الورثة.</LockedNotice> : <form onSubmit={submitDeclaration} className="decision-form">
                <label>القطعة اللي هتعلنها<select value={props.declarationLot} onChange={(event) => props.setDeclarationLot(event.target.value)}><option value="">من غير إعلان</option>{game.lots.map((lot) => <option key={lot.id} value={lot.id}>{lot.nameAr} · {lot.id}</option>)}</select></label>
                <label>بطاقة الجولة<select value={props.selectedCardId} onChange={(event) => { const value = event.target.value; props.setSelectedCardId(value ? Number(value) : ""); }}><option value="">من غير بطاقة</option>{hand.map((id) => <option key={id} value={id}>{String(id).padStart(2, "0")} · {PLAYABLE_CARDS.get(id)?.name ?? cardNames.get(id)}</option>)}</select></label>
                {props.selectedCardId !== "" && <p className="card-effect-copy">{PLAYABLE_CARDS.get(props.selectedCardId)?.effect ?? "تأثير البطاقة هيتسجل ضمن حسم الجولة."}</p>}
                {[16, 19].includes(Number(props.selectedCardId)) && <label>الإعلان عن قطعة تانية<select value={props.alternateDeclarationLot} onChange={(event) => props.setAlternateDeclarationLot(event.target.value)}><option value="">اختار قطعة مختلفة</option>{game.lots.filter((lot) => lot.id !== props.declarationLot).map((lot) => <option key={lot.id} value={lot.id}>{lot.nameAr} · {lot.id}</option>)}</select></label>}
                {[17, 37, 57].includes(Number(props.selectedCardId)) && <label>{props.selectedCardId === 17 ? "مكان الظرف الوهمي" : props.selectedCardId === 37 ? "القطعة اللي عليها الشرط" : "القطعة المحمية"}<select value={props.cardTargetLotId} onChange={(event) => props.setCardTargetLotId(event.target.value)}><option value="">اختار قطعة</option>{game.lots.map((lot) => <option key={lot.id} value={lot.id}>{lot.nameAr} · {lot.id}</option>)}</select></label>}
                {props.selectedCardId === 27 && <label>تعديل العرض<select value={cardDirection} onChange={(event) => setCardDirection(event.target.value)}><option value="up">زوده نقطة</option><option value="down">قلله نقطة</option></select></label>}
                {props.selectedCardId === 28 && (privateGame?.nextRoundLotChoices?.length ?? 0) >= 2 && <label>مين ييجي الأول الجولة الجاية<select value={nextRoundFirstLotId} onChange={(event) => setNextRoundFirstLotId(event.target.value)}><option value="">اختار من أول قطعتين</option>{(privateGame?.nextRoundLotChoices ?? []).map((lot) => <option key={lot.id} value={lot.id}>{lot.nameAr} · {lot.id}</option>)}</select></label>}
                {props.selectedCardId === 28 && (privateGame?.nextRoundLotChoices?.length ?? 0) < 2 && <p className="card-effect-copy">مفيش جولة جاية فيها ملفّين نرتّبهم؛ الكارت هيتسجل من غير تأثير.</p>}
                {props.selectedCardId === 29 && <label>العلامة اللي هتعلنها<select value={illusionStance} onChange={(event) => setIllusionStance(event.target.value as "trust" | "doubt")}><option value="trust">ثقة</option><option value="doubt">شك</option></select></label>}
                {props.selectedCardId === 60 && <label>اختيارك للصفحة الأخيرة<select value={lastPageChoice} onChange={(event) => setLastPageChoice(event.target.value)}><option value="bid">زود العرض نقطة</option><option value="suspicion">قلل الشك نقطة</option></select></label>}
                {props.selectedCardId === 23 && <><label>العلامة اللي معلنها<select value={props.declarationStanceKind} onChange={(event) => props.setDeclarationStanceKind(event.target.value as "trust" | "doubt" | "")}><option value="">من غير علامة</option><option value="trust">ثقة</option><option value="doubt">شك</option></select></label>{props.declarationStanceKind && <label>اللاعب المستهدف في إعلانك<select value={props.declarationStanceTarget} onChange={(event) => props.setDeclarationStanceTarget(event.target.value)}><option value="">اختار لاعب</option>{targetPlayers.map((player) => <option key={player.playerId} value={player.playerId}>{player.displayName}</option>)}</select></label>}<label>الحقل اللي هتخفيه<select value={props.hiddenDeclarationField} onChange={(event) => props.setHiddenDeclarationField(event.target.value as "targetLotId" | "bidBand" | "stance" | "")}>{props.declarationLot && <option value="targetLotId">القطعة المعلنة</option>}{props.declarationBand && <option value="bidBand">نطاق العرض</option>}{props.declarationStanceKind && props.declarationStanceTarget && <option value="stance">العلامة المعلنة</option>}<option value="">اختار حقل معلن</option></select></label></>}
                <label>متوقع تعرض كام؟<select value={props.declarationBand} onChange={(event) => props.setDeclarationBand(event.target.value as "0-1" | "2-3" | "")}><option value="">مش هحدد</option><option value="0-1">من ٠ لـ١</option><option value="2-3">من ٢ لـ٣</option></select></label>
                <button className="primary-button" type="submit" disabled={props.busy || ([16, 19].includes(Number(props.selectedCardId)) && (!props.declarationLot || !props.alternateDeclarationLot)) || (props.selectedCardId === 23 && (!props.hiddenDeclarationField || (props.hiddenDeclarationField === "targetLotId" && !props.declarationLot) || (props.hiddenDeclarationField === "bidBand" && !props.declarationBand) || (props.hiddenDeclarationField === "stance" && (!props.declarationStanceKind || !props.declarationStanceTarget)))) || ([17, 37, 57].includes(Number(props.selectedCardId)) && !props.cardTargetLotId) || (props.selectedCardId === 28 && (privateGame?.nextRoundLotChoices?.length ?? 0) >= 2 && !nextRoundFirstLotId)}>اقفل الإعلان <span aria-hidden="true">↗</span></button>
              </form>}
            </>}

            {game.phase === "wager-commit" && <>
              <div className="phase-intro"><span className="phase-step">٢</span><div><span className="section-kicker">سري لحد الحسم</span><h2>هتتوقع لاعب هيختار إيه؟</h2><p>لو توقعت صح تكسب +٢، ولو غلط تخسر ٣. وتقدر تعدّي من غير ما تخسر حاجة.</p></div></div>
              {locked ? <LockedNotice>تم قفل توقعك. لن يراه أحد قبل التسوية.</LockedNotice> : <form onSubmit={submitWager} className="decision-form">
                <label>الوريث المستهدف<select value={props.wagerTarget} onChange={(event) => props.setWagerTarget(event.target.value)}><option value="">مرور بلا توقع</option>{targetPlayers.map((player) => <option key={player.playerId} value={player.playerId}>{player.displayName}</option>)}</select></label>
                <label>توقّع اختياره<select value={props.wagerLot} onChange={(event) => props.setWagerLot(event.target.value)}><option value="">اختر قطعة</option>{game.lots.map((lot) => <option key={lot.id} value={lot.id}>{lot.nameAr}</option>)}</select></label>
                <button className="primary-button" type="submit" disabled={props.busy}>{props.wagerTarget && props.wagerLot ? "اقفل التوقع" : "مرور بلا توقع"}<span aria-hidden="true">↗</span></button>
              </form>}
            </>}

            {game.phase === "negotiation" && <>
              <div className="phase-intro"><span className="phase-step">٣</span><div><span className="section-kicker">وقت التفاوض · {props.room.settings.negotiationSeconds} ثانية</span><h2>قولوا اللي عندكم</h2><p>الكلام لوحده مش عقد. تقدر تسكت أو تخلص تفاوضك في أي وقت.</p></div></div>
              {me?.ready ? <LockedNotice>أنهيت تفاوضك. بانتظار الآخرين.</LockedNotice> : <>
                {renegotiationControl}
                {[2, 7, 8, 12, 20, 21, 25, 26, 31, 33, 34, 36, 38, 39, 41, 42, 44, 45, 46, 59].includes(privateGame?.lockedCardId ?? 0) && <label className="negotiation-target">اختار الشخص المقصود بالكارت<select value={props.cardTargetId} onChange={(event) => props.setCardTargetId(event.target.value)}><option value="">اختار لاعب</option>{privateGame?.lockedCardId === 46 && props.currentPlayer && <option value={props.currentPlayer.playerId}>{props.currentPlayer.displayName} · أنا</option>}{targetPlayers.map((player) => <option key={player.playerId} value={player.playerId}>{player.displayName}</option>)}</select></label>}
                {privateGame?.lockedCardId === 2 && props.cardTargetId && <div className="contract-maker card-effect-copy">
                  <label>شرط العقد<select value={contractKind} onChange={(event) => setContractKind(event.target.value)}><option value="no-bid">لا تزايد على قطعة</option><option value="different-lots">كل واحد يختار قطعة مختلفة</option><option value="transfer">تحويل نفوذ لو متاح</option></select></label>
                  {contractKind === "no-bid" && <><label>مين الملتزم؟<select value={contractBoundPlayerId} onChange={(event) => setContractBoundPlayerId(event.target.value)}><option value="">اختار طرف العقد</option><option value={props.currentPlayer?.playerId}>{props.currentPlayer?.displayName} مايزايدش</option><option value={props.cardTargetId}>{targetPlayers.find((player) => player.playerId === props.cardTargetId)?.displayName ?? "الطرف التاني"} مايزايدش</option></select></label><label>على أنهي قطعة؟<select value={contractLotId} onChange={(event) => setContractLotId(event.target.value)}><option value="">اختار قطعة</option>{game.lots.map((lot) => <option key={lot.id} value={lot.id}>{lot.nameAr}</option>)}</select></label></>}
                  {contractKind === "transfer" && <><label>اتجاه التحويل<select value={contractTransferDirection} onChange={(event) => setContractTransferDirection(event.target.value)}><option value="to-target">إنت تحوّل للطرف التاني</option><option value="to-owner">الطرف التاني يحوّل لك</option></select></label><label>مقدار النفوذ<select value={contractTransferAmount} onChange={(event) => setContractTransferAmount(Number(event.target.value))}><option value={1}>١</option><option value={2}>٢</option><option value={3}>٣</option></select></label></>}
                  <button type="button" className="secondary-button" disabled={props.busy || (contractKind === "no-bid" && (!contractBoundPlayerId || !contractLotId))} onClick={() => {
                    const ownerId = props.currentPlayer?.playerId ?? "";
                    const condition = contractKind === "no-bid" ? { kind: contractKind, playerId: contractBoundPlayerId, lotId: contractLotId }
                      : contractKind === "different-lots" ? { kind: contractKind }
                        : { kind: contractKind, fromPlayerId: contractTransferDirection === "to-target" ? ownerId : props.cardTargetId, toPlayerId: contractTransferDirection === "to-target" ? props.cardTargetId : ownerId, amount: contractTransferAmount };
                    void props.onGameAction("OFFER_CONTRACT", { targetPlayerId: props.cardTargetId, condition });
                  }}>قدّم العرض المكتوب</button>
                </div>}
                {game.formalContract && <p className="card-effect-copy">العقد: {game.formalContract.status === "pending" ? "مستني قبول الطرف التاني" : game.formalContract.status === "accepted" ? "اتقبل واتحط نقطة نفوذ من كل طرف في الأمان" : game.formalContract.status === "declined" ? "الطرف التاني رفضه" : game.formalContract.status === "fulfilled" ? "اتنفذ واتسوى" : game.formalContract.status === "voided" ? "اتلغى تحويل الأمان بكارت ٥٥" : "اتنقض واتسوى"}</p>}
                {privateGame?.contractPrompt && <div className="card-response-prompt"><p><b>قدامك عقد مكتوب</b> من لاعب تاني. القبول يخصم نقطة نفوذ منك ومنه ويحطهم أمان.</p><button type="button" className="secondary-button" disabled={props.busy || (me?.influence ?? 0) < 1} onClick={() => void props.onGameAction("RESPOND_CONTRACT", { accept: true })}>أقبل العقد</button><button type="button" className="story-skip" disabled={props.busy} onClick={() => void props.onGameAction("RESPOND_CONTRACT", { accept: false })}>أرفض</button></div>}
                <button className="primary-button" type="button" disabled={props.busy || ([2, 7, 8, 12, 20, 21, 25, 26, 31, 33, 34, 36, 38, 39, 41, 42, 44, 45, 46, 59].includes(privateGame?.lockedCardId ?? 0) && !props.cardTargetId)} onClick={() => { void props.onGameAction("FINISH_NEGOTIATION", props.cardTargetId ? { cardParameters: { targetPlayerId: props.cardTargetId } } : {}); props.setCardTargetId(""); }}>انتهيت من التفاوض <span aria-hidden="true">↗</span></button>
              </>}
            </>}

            {game.phase === "final-action" && <>
              <div className="phase-intro"><span className="phase-step">٤</span><div><span className="section-kicker">اختيار سري · عرض من ٠ لـ٣</span><h2>وقّع اختيارك الأخير</h2><p>اختار قطعة أو عدّي. كل مزايد بيدفع عرضه الأساسي حتى لو ماكسبش.</p></div></div>
              {locked ? <LockedNotice>قُفل اختيارك النهائي. لن يظهر قبل قفل الجميع.</LockedNotice> : <form onSubmit={submitAction} className="decision-form">
                {renegotiationControl}
                <label>القطعة<select value={props.finalLot} onChange={(event) => { props.setFinalLot(event.target.value); if (!event.target.value) props.setBaseBid(0); }}><option value="">مرور بلا مزايدة</option>{game.lots.map((lot) => <option key={lot.id} value={lot.id}>{lot.nameAr} · {lot.id}</option>)}</select></label>
                <label>عرضك الأساسي <b>{props.finalLot ? props.baseBid : 0}</b><input type="range" min="0" max={bidCap} value={props.finalLot ? Math.min(props.baseBid, bidCap) : 0} disabled={!props.finalLot || bidCap === 0} onChange={(event) => props.setBaseBid(Number(event.target.value))} /><span className="range-ends"><small>٠</small><small>{bidCap} · المتاح بعد كلفة البطاقة</small></span></label>
                <label>موقفك تجاه لاعب<select value={props.stanceKind} onChange={(event) => props.setStanceKind(event.target.value as "pass" | "trust" | "doubt")}><option value="pass">مرور · بلا أثر</option><option value="trust">ثقة · +١ للهدف إن تنافستما على القطعة نفسها</option><option value="doubt">شك · +١ في مسار الشك</option></select></label>
                {props.stanceKind !== "pass" && <label>اللاعب المستهدف<select required value={props.stanceTarget} onChange={(event) => props.setStanceTarget(event.target.value)}><option value="">اختر لاعباً</option>{targetPlayers.map((player) => <option key={player.playerId} value={player.playerId}>{player.displayName}</option>)}</select></label>}
                <button className="primary-button" type="submit" disabled={props.busy || (props.stanceKind !== "pass" && !props.stanceTarget)}>اقفل الاختيار <span aria-hidden="true">↗</span></button>
              </form>}
            </>}

            {game.phase === "card-response" && <>
              <div className="phase-intro"><span className="phase-step">↗</span><div><span className="section-kicker">كل الاختيارات اتكشفت</span><h2>فيه ورق محتاج ردّك</h2><p>اختار ردّك على كل كارت وصلك. لو الوقت خلص، اللعبة هتطبق الرد الآمن تلقائي.</p></div></div>
              {(privateGame?.cardPrompts ?? []).map((prompt) => {
                const key = `${prompt.sourcePlayerId}:${prompt.cardId}`;
                const cardTitle = PLAYABLE_CARDS.get(prompt.cardId)?.name ?? CARD_SOURCE.find((card) => card.id === prompt.cardId)?.name ?? `بطاقة ${prompt.cardId}`;
                const effectTitle = PLAYABLE_CARDS.get(prompt.effectCardId ?? prompt.cardId)?.name ?? CARD_SOURCE.find((card) => card.id === (prompt.effectCardId ?? prompt.cardId))?.name ?? cardTitle;
                const reply = cardReplyChoices[key] ?? "";
                const eligibleHand = hand.filter((id) => id !== privateGame?.lockedCardId);
                const asksReveal = reply === "reveal-card" || reply === "reveal-category";
                const needsReveal = prompt.cardId === 33 || asksReveal;
                return <article className="card-response-prompt" key={key}>
                  <p>{prompt.effectCardId === 52 ? <><b>الكارت رجع عليك</b> بسبب «رد الضربة». دلوقتي اختار ردك إنت.</> : <><b>{prompt.sourceName}</b> لعب كارت «{effectTitle}» عليك.</>}</p>
                  {prompt.cardId === 33 && <label>اختار كارت واحد تكشفه<select value={cardReplyIds[key] ?? ""} onChange={(event) => setCardReplyIds((current) => ({ ...current, [key]: event.target.value ? Number(event.target.value) : "" }))}><option value="">اختار كارت</option>{eligibleHand.map((id) => <option key={id} value={id}>{String(id).padStart(2, "0")} · {CARD_SOURCE.find((card) => card.id === id)?.name}</option>)}</select></label>}
                  {[39, 42, 45, 52, 58].includes(prompt.cardId) && <label>{prompt.cardId === 52 ? "ترجع التأثير لصاحبه؟" : prompt.cardId === 58 ? "تأجله ولا تلغيه؟" : "ردّك"}<select value={reply} onChange={(event) => setCardReplyChoices((current) => ({ ...current, [key]: event.target.value }))}><option value="">اختار رد</option>{prompt.cardId === 52 && <><option value="reflect">آه، اعكس تأثيره</option><option value="allow">لأ، سيبه يعدّي</option></>}{prompt.cardId === 58 && <><option value="defer">أجّله وخليه ظاهر في السجل</option><option value="cancel">ادفع ١ نفوذ وألغيه دلوقتي</option><option value="allow">لأ، حلّه دلوقتي</option></>}{[39, 42, 45].includes(prompt.cardId) && <option value="pay">ادفع ١ نفوذ{me?.influence ? "" : " · مش متاح"}</option>}{prompt.cardId === 39 && <option value="reveal-card">اكشف كارت واحد</option>}{prompt.cardId === 42 && <option value="reveal-category">اكشف فئة كارت واحد بس</option>}{prompt.cardId === 45 && <option value="suspicion">زود الشك نقطة</option>}</select></label>}
                  {needsReveal && prompt.cardId !== 33 && <label>الكارت اللي هتكشفه<select value={cardReplyIds[key] ?? ""} onChange={(event) => setCardReplyIds((current) => ({ ...current, [key]: event.target.value ? Number(event.target.value) : "" }))}><option value="">اختار كارت</option>{eligibleHand.map((id) => <option key={id} value={id}>{String(id).padStart(2, "0")} · {CARD_SOURCE.find((card) => card.id === id)?.name}</option>)}</select></label>}
                  <button className="secondary-button" type="button" disabled={props.busy || (prompt.cardId === 33 ? typeof cardReplyIds[key] !== "number" : !reply || (reply === "pay" && (me?.influence ?? 0) < 1) || (reply === "cancel" && (me?.influence ?? 0) - (me?.action?.baseBid ?? 0) < 1) || (asksReveal && typeof cardReplyIds[key] !== "number"))} onClick={() => submitCardReply(prompt)}>أكد ردّك</button>
                </article>;
              })}
              {!privateGame?.cardPrompts?.length && <LockedNotice>مفيش رد مطلوب منك؛ مستنيين بقية المجلس.</LockedNotice>}
            </>}

            {game.phase === "resolution" && <LockedNotice>كُشفت الاختيارات. يجري الخادم حسم المزايدات والتسوية.</LockedNotice>}
            {game.pendingPressureEffects?.length ? <div className="card-response-prompt"><b>التزامات مؤجلة</b>{game.pendingPressureEffects.map((effect, index) => <article key={`${effect.sourcePlayerId}-${effect.targetPlayerId}-${index}`}><p>{game.players.find((player) => player.playerId === effect.targetPlayerId)?.displayName ?? "لاعب"}: {effect.kind === "influence" ? `دفع ${effect.amount} نفوذ` : `زيادة الشك ${effect.amount}`} في نهاية الجولة {effect.dueRoundIndex}.</p>{effect.targetPlayerId === props.currentPlayer?.playerId && <button type="button" className="secondary-button" disabled={props.busy || (me?.influence ?? 0) < 1 || game.phase === "complete" || game.phase === "round-summary"} onClick={() => void props.onGameAction("CANCEL_PENDING_PRESSURE", { sourcePlayerId: effect.sourcePlayerId, sourceCardId: effect.sourceCardId })}>ادفع ١ نفوذ وألغيه</button>}</article>)}</div> : null}

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
            <div className="hand-list">{hand.map((id) => <div className="hand-card" key={id}><span className="card-number">{String(id).padStart(2, "0")}</span><span>{cardNames.get(id) ?? "بطاقة"}</span><small>{id === privateGame?.lockedCardId ? "مختارة للجولة" : "اختارها وقت إعلانك"}</small></div>)}{hand.length === 0 && <p className="muted-copy">إيدك فاضية دلوقتي.</p>}</div>
            <p className="private-note">اختار بطاقة واحدة وقت إعلانك. تأثيرها وشروطها هتظهر في سجل الجولة بعد الحسم.</p>
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
  const cardEffects = Array.isArray(results.cardEffects) ? results.cardEffects as Array<Record<string, unknown> & { playerId: string; cardId: number; status: "applied" | "no-op"; reason: string }> : [];
  return <div className="round-result">
    <h3>المزايدات</h3>
    {auctions.map((auction) => <article className="audit-lot" key={auction.lotId}><b>القطعة {auction.lotId}</b><span>{auction.winnerPlayerId ? `الفائز: ${players.find((player) => player.playerId === auction.winnerPlayerId)?.displayName}` : auction.tiedPlayerIds.length ? "تعادل بلا فائز" : "بلا مزايد"}</span>{auction.bidResolutions.map((bid) => <small key={bid.playerId}>{players.find((player) => player.playerId === bid.playerId)?.displayName}: أساس {bid.baseBid} ← {bid.effectiveBid}{bid.won ? " · فاز" : ""}</small>)}</article>)}
    <h3>المكافآت والتوقعات</h3>
    <p>{lots.filter((lot) => lot.winnerPlayerId).map((lot) => `${players.find((player) => player.playerId === lot.winnerPlayerId)?.displayName}: ${rewardLabel(lot)}`).join(" · ") || "لم يحصل أحد على قطعة هذه الجولة."}</p>
    {wagers.map((wager, index) => <small className="audit-wager" key={index}>توقع {players.find((player) => player.playerId === wager.bettorPlayerId)?.displayName} على {players.find((player) => player.playerId === wager.targetPlayerId)?.displayName}: {wager.result === "void" ? "ملغى" : wager.result ? `صحيح +${wager.delta}` : `غير صحيح ${wager.delta}`}</small>)}
    {cardEffects.length > 0 && <><h3>الكروت اللي اتلعبت</h3><div className="audit-card-effects">{cardEffects.map((effect, index) => {
      const playerName = players.find((player) => player.playerId === effect.playerId)?.displayName ?? "لاعب";
      const details: string[] = [];
      for (const [key, label] of [["influenceCost", "دفع نفوذ"], ["refund", "رجع نفوذ"], ["influence", "نفوذ"], ["bidBonus", "زيادة عرض"], ["bidPenalty", "خصم عرض"], ["effectiveBidChange", "تغيير العرض"], ["suspicionAdded", "شك زاد"], ["suspicionRemoved", "شك اتشال"], ["scandalAdded", "فضيحة زادت"]] as const) {
        const value = effect[key];
        if (typeof value === "number" && value !== 0) details.push(`${label} ${value > 0 && ["bidBonus", "influence", "refund", "suspicionRemoved", "scandalAdded"].includes(key) ? "+" : ""}${value}`);
      }
      const targetName = typeof effect.targetPlayerId === "string" ? players.find((player) => player.playerId === effect.targetPlayerId)?.displayName : undefined;
      if (targetName) details.push(`الطرف التاني: ${targetName}`);
      const lotId = typeof effect.toLotId === "string" ? effect.toLotId : typeof effect.lotId === "string" ? effect.lotId : undefined;
      if (lotId) details.push(`القطعة ${lotId}`);
      const contractStatus = typeof effect.formalContract === "object" && effect.formalContract !== null ? (effect.formalContract as { status?: string }).status : undefined;
      if (contractStatus) details.push(contractStatus === "fulfilled" ? "العقد اتنفذ" : contractStatus === "voided" ? "الأمان رجع لأصحابه" : "العقد اتسوى بعد الخلاف");
      return <article className="audit-card-effect" key={`${effect.cardId}-${effect.playerId}-${index}`}><b>{playerName}</b><span>كارت {String(effect.cardId).padStart(2, "0")} · {PLAYABLE_CARDS.get(effect.cardId)?.name ?? "بطاقة"}</span><small>{effect.status === "applied" ? "اتنفذ" : "شرطه ما اتحققش"}{details.length ? ` · ${details.join(" · ")}` : ""}</small></article>;
    })}</div></>}
  </div>;
}
