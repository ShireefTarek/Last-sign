import { useEffect, useRef, useState, type CSSProperties } from "react";
import * as THREE from "three";

export type TableLookTarget =
  | { kind: "center" }
  | { kind: "documents" }
  | { kind: "cards" }
  | { kind: "left" }
  | { kind: "right" }
  | { kind: "player"; playerId: string };

export type TableGesture = "wave" | "point" | "thinking" | "shrug" | "agree" | "like" | "disagree";

export type TablePose = {
  playerId: string;
  lookAt: TableLookTarget;
  gesture: TableGesture | null;
  showCards?: boolean;
  updatedAt: number;
};

export type TableSeat = {
  playerId: string;
  displayName: string;
  seatIndex: number;
  connected: boolean;
  isYou: boolean;
};

export type TableLot = { id?: string; nameAr: string; status: string };
export type TablePoseChange = { lookAt?: TableLookTarget; gesture?: TableGesture | null; showCards?: boolean };

type AvatarModel = {
  playerId: string;
  seat: TableSeat;
  root: THREE.Group;
  head: THREE.Group;
  torso: THREE.Group;
  leftArm: THREE.Group;
  rightArm: THREE.Group;
  rightThumb: THREE.Object3D;
  cardFan: THREE.Group;
  baseYaw: number;
  index: number;
};

const palette = [0x6e3f36, 0x385c50, 0x82683d, 0x485776, 0x704e72, 0x58745b, 0x8a4f45, 0x486c78, 0x78634e, 0x55504e, 0x697b56, 0x705069];
const skinTones = [0xc78e66, 0xd19d78, 0xa96f50, 0xe0b38d, 0x966044, 0xbc825f];
const characterRoles = ["الوريث الحذر", "الموثّقة", "صاحب المزاد", "حافظة الأسرار", "المحامي", "قريب العائلة", "الوريث الطموح", "الراوية", "جامع التحف", "الوسيط الهادئ", "المتشككة", "كاتب الوصية"];
const gestureLabels: Record<TableGesture, string> = {
  wave: "لوّح",
  point: "أشر ناحية اللي باصصله",
  thinking: "فكّر",
  shrug: "ارفع كتفيك",
  agree: "أومئ بالموافقة",
  like: "اعمل لايك 👍",
  disagree: "هز راسك لأ",
};

function roundedColor(index: number): string {
  return `#${palette[index % palette.length]!.toString(16).padStart(6, "0")}`;
}

function material(color: THREE.ColorRepresentation, roughness = 0.8, metalness = 0): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness });
}

function addMesh(
  parent: THREE.Object3D,
  geometry: THREE.BufferGeometry,
  surface: THREE.Material,
  position: THREE.Vector3 | [number, number, number],
  rotation?: [number, number, number],
): THREE.Mesh {
  const mesh = new THREE.Mesh(geometry, surface);
  if (position instanceof THREE.Vector3) mesh.position.copy(position);
  else mesh.position.set(...position);
  if (rotation) mesh.rotation.set(...rotation);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

function makePaperTexture(title: string, subtitle = "وثيقة من ملف الميراث"): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 384;
  canvas.height = 256;
  const context = canvas.getContext("2d");
  if (context) {
    context.fillStyle = "#eee2c8";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.strokeStyle = "#8b6c42";
    context.lineWidth = 7;
    context.strokeRect(8, 8, canvas.width - 16, canvas.height - 16);
    context.direction = "rtl";
    context.textAlign = "center";
    context.fillStyle = "#51372c";
    context.font = "bold 40px Tahoma, sans-serif";
    context.fillText(title.slice(0, 20), canvas.width / 2, 111, canvas.width - 38);
    context.fillStyle = "#8b6c42";
    context.font = "24px Tahoma, sans-serif";
    context.fillText(subtitle, canvas.width / 2, 165, canvas.width - 36);
    context.fillStyle = "#a74332";
    context.beginPath();
    context.arc(canvas.width / 2, 207, 12, 0, Math.PI * 2);
    context.fill();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function buildChair(parent: THREE.Object3D, yaw: number): void {
  const wood = material(0x38271e, 0.62);
  const brass = material(0x987443, 0.35, 0.5);
  const chair = new THREE.Group();
  chair.rotation.y = yaw;
  parent.add(chair);
  addMesh(chair, new THREE.BoxGeometry(1.08, 0.19, 1.02), wood, [0, 0.66, -0.07]);
  addMesh(chair, new THREE.BoxGeometry(1.1, 1.12, 0.17), wood, [0, 1.2, -0.55], [-0.08, 0, 0]);
  for (const x of [-0.42, 0.42]) {
    addMesh(chair, new THREE.CylinderGeometry(0.055, 0.075, 0.62, 8), brass, [x, 0.35, -0.43]);
    addMesh(chair, new THREE.CylinderGeometry(0.055, 0.075, 0.62, 8), brass, [x, 0.35, 0.34]);
  }
  addMesh(chair, new THREE.BoxGeometry(0.12, 0.16, 0.86), brass, [-0.54, 0.75, -0.06]);
  addMesh(chair, new THREE.BoxGeometry(0.12, 0.16, 0.86), brass, [0.54, 0.75, -0.06]);
}

function relationLabel(seat: TableSeat, total: number, offset: number): string {
  const delta = (seat.seatIndex - offset + total) % total;
  if (delta === 0) return "إنت";
  if (delta === 1) return "على شمالك";
  if (delta === total - 1) return "على يمينك";
  if (delta === Math.floor(total / 2)) return "مقابلك";
  return delta < total / 2 ? "ناحيتك الشمال" : "ناحيتك اليمين";
}

function addNameTag(parent: THREE.Object3D, name: string, role: string, relation: string, color: string): THREE.Sprite {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 120;
  const context = canvas.getContext("2d");
  if (context) {
    context.fillStyle = "rgba(16, 24, 19, 0.88)";
    context.beginPath();
    context.roundRect(8, 6, 496, 108, 18);
    context.fill();
    context.strokeStyle = color;
    context.lineWidth = 3;
    context.stroke();
    context.direction = "rtl";
    context.textAlign = "center";
    context.fillStyle = "#fff2d8";
    context.font = "bold 38px Tahoma, sans-serif";
    context.fillText(name.slice(0, 20), 256, 53, 460);
    context.fillStyle = "#e1c587";
    context.font = "24px Tahoma, sans-serif";
    context.fillText(`${relation} · ${role}`, 256, 91, 460);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false }));
  label.position.set(0, 2.42, 0);
  label.scale.set(2.25, 0.53, 1);
  parent.add(label);
  return label;
}

function buildAvatar(seat: TableSeat, index: number, total: number, offset: number): AvatarModel {
  const angle = ((seat.seatIndex - offset) / total) * Math.PI * 2 + Math.PI / 2;
  const x = Math.cos(angle) * 6.1;
  const z = Math.sin(angle) * 4.65;
  const yaw = Math.atan2(-x, -z);
  const root = new THREE.Group();
  root.position.set(x, 0.06, z);
  root.rotation.y = yaw;
  root.userData.playerId = seat.playerId;

  const chairOffset = new THREE.Vector3(Math.cos(angle) * 0.22, 0, Math.sin(angle) * 0.22);
  const chairRoot = new THREE.Group();
  chairRoot.position.copy(chairOffset);
  root.add(chairRoot);
  buildChair(chairRoot, 0);

  const robe = material(palette[index % palette.length]!, 0.72);
  const trim = material(index % 2 === 0 ? 0xc69c56 : 0x71836d, 0.55, 0.08);
  const skin = material(skinTones[index % skinTones.length]!, 0.78);
  const dark = material(0x30231f, 0.95);
  const eye = material(0x201b19, 0.7);
  const role = characterRoles[seat.seatIndex % characterRoles.length]!;
  const label = addNameTag(root, seat.displayName, role, relationLabel(seat, total, offset), roundedColor(index));

  const torso = new THREE.Group();
  torso.position.y = 0.83;
  root.add(torso);
  addMesh(torso, new THREE.CapsuleGeometry(0.44, 0.72, 4, 10), robe, [0, 0.13, 0]);
  addMesh(torso, new THREE.BoxGeometry(0.13, 0.64, 0.055), trim, [0, 0.05, 0.43]);
  addMesh(torso, new THREE.SphereGeometry(0.1, 12, 8), material(0xb99758, 0.32, 0.55), [0, 0.07, 0.49]);
  addMesh(torso, new THREE.CylinderGeometry(0.18, 0.2, 0.1, 14), skin, [0, 0.68, 0]);

  const head = new THREE.Group();
  head.position.set(0, 1.62, 0.01);
  root.add(head);
  addMesh(head, new THREE.SphereGeometry(0.34, 18, 14), skin, [0, 0, 0]);
  addMesh(head, new THREE.SphereGeometry(0.36, 18, 10, 0, Math.PI * 2, 0, Math.PI * 0.56), dark, [0, 0.09, -0.035]);
  addMesh(head, new THREE.SphereGeometry(0.07, 12, 8), skin, [-0.33, -0.04, 0.02]);
  addMesh(head, new THREE.SphereGeometry(0.07, 12, 8), skin, [0.33, -0.04, 0.02]);
  for (const eyeX of [-0.115, 0.115]) {
    addMesh(head, new THREE.SphereGeometry(0.035, 10, 8), eye, [eyeX, 0.045, 0.294]);
    addMesh(head, new THREE.SphereGeometry(0.011, 8, 6), material(0xf6e7ce, 0.3), [eyeX - 0.008, 0.055, 0.323]);
  }
  addMesh(head, new THREE.ConeGeometry(0.048, 0.13, 7), skin, [0, -0.035, 0.32], [Math.PI / 2, 0, 0]);
  addMesh(head, new THREE.BoxGeometry(0.12, 0.018, 0.015), dark, [0, -0.17, 0.3]);
  if (index % 4 === 1) {
    const glasses = material(0x443728, 0.34, 0.35);
    for (const frameX of [-0.115, 0.115]) {
      addMesh(head, new THREE.TorusGeometry(0.07, 0.012, 6, 14), glasses, [frameX, 0.045, 0.31]);
    }
    addMesh(head, new THREE.BoxGeometry(0.09, 0.014, 0.012), glasses, [0, 0.045, 0.31]);
  } else if (index % 4 === 2) {
    addMesh(head, new THREE.SphereGeometry(0.17, 12, 8), dark, [0, -0.2, 0.19], [0.35, 0, 0]);
  } else if (index % 4 === 3) {
    addMesh(head, new THREE.CylinderGeometry(0.34, 0.34, 0.06, 18), trim, [0, 0.28, 0]);
    addMesh(head, new THREE.CylinderGeometry(0.15, 0.17, 0.17, 12), dark, [0, 0.38, 0]);
  }

  const leftArm = new THREE.Group();
  leftArm.position.set(-0.39, 1.29, 0.02);
  root.add(leftArm);
  const rightArm = new THREE.Group();
  rightArm.position.set(0.39, 1.29, 0.02);
  root.add(rightArm);
  for (const arm of [leftArm, rightArm]) {
    addMesh(arm, new THREE.CapsuleGeometry(0.13, 0.46, 3, 8), robe, [0, -0.31, 0]);
    addMesh(arm, new THREE.SphereGeometry(0.135, 10, 8), skin, [0, -0.63, 0.015]);
  }
  const rightThumb = addMesh(rightArm, new THREE.CapsuleGeometry(0.055, 0.16, 3, 6), skin, [0.11, -0.56, 0.035], [0, 0, -0.6]);
  rightThumb.visible = false;

  const cardFan = new THREE.Group();
  root.add(cardFan);
  cardFan.position.set(0, 1.4, -1.22);
  void label;
  return { playerId: seat.playerId, seat, root, head, torso, leftArm, rightArm, rightThumb, cardFan, baseYaw: yaw, index };
}

function createScene(renderer: THREE.WebGLRenderer): {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  tableItems: THREE.Group;
  avatars: THREE.Group;
} {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x17221e);
  scene.fog = new THREE.Fog(0x17221e, 23, 46);
  scene.add(new THREE.HemisphereLight(0xf5e6c8, 0x334337, 2.1));
  const keyLight = new THREE.DirectionalLight(0xffe6bd, 3.4);
  keyLight.position.set(-7, 13, 9);
  keyLight.castShadow = true;
  keyLight.shadow.mapSize.set(1024, 1024);
  scene.add(keyLight);
  const fill = new THREE.PointLight(0xc58c4a, 55, 24, 2);
  fill.position.set(2, 5, -3);
  scene.add(fill);

  const floor = material(0x332a22, 0.92);
  addMesh(scene, new THREE.PlaneGeometry(100, 100), floor, [0, -0.16, 0], [-Math.PI / 2, 0, 0]);

  const rug = new THREE.Group();
  scene.add(rug);
  addMesh(rug, new THREE.CylinderGeometry(6.8, 6.8, 0.08, 64), material(0x293b31, 0.96), [0, -0.08, 0]).scale.set(1.2, 1, 0.88);
  const rugRing = addMesh(rug, new THREE.TorusGeometry(6.1, 0.035, 8, 72), material(0x9e7845, 0.52, 0.2), [0, -0.015, 0], [Math.PI / 2, 0, 0]);
  rugRing.scale.set(1.2, 0.88, 1);

  const table = new THREE.Group();
  scene.add(table);
  const wood = material(0x513724, 0.4, 0.08);
  const darkWood = material(0x2f241d, 0.38, 0.12);
  addMesh(table, new THREE.CylinderGeometry(4.3, 4.42, 0.32, 64), wood, [0, 1.18, 0]).scale.set(1.18, 1, 0.86);
  const trim = addMesh(table, new THREE.TorusGeometry(4.24, 0.075, 10, 72), material(0xc49a56, 0.28, 0.62), [0, 1.32, 0], [Math.PI / 2, 0, 0]);
  trim.scale.set(1.18, 0.86, 1);
  addMesh(table, new THREE.CylinderGeometry(1.65, 2.05, 0.84, 32), darkWood, [0, 0.61, 0]).scale.set(1.1, 1, 0.9);
  addMesh(table, new THREE.CylinderGeometry(2.4, 2.5, 0.12, 32), darkWood, [0, 0.16, 0]).scale.set(1.1, 1, 0.9);
  const leather = addMesh(table, new THREE.CylinderGeometry(3.8, 3.8, 0.028, 64), material(0x28463a, 0.98), [0, 1.35, 0]);
  leather.scale.set(1.12, 1, 0.78);

  const tableItems = new THREE.Group();
  tableItems.position.y = 1.37;
  table.add(tableItems);
  const avatars = new THREE.Group();
  scene.add(avatars);

  const camera = new THREE.PerspectiveCamera(41, 1, 0.1, 80);
  camera.position.set(0, 14.4, 17.2);
  camera.lookAt(0, 0.9, 0);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  return { scene, camera, tableItems, avatars };
}

function clearGroup(group: THREE.Group): void {
  for (const child of [...group.children]) {
    group.remove(child);
    child.traverse((object) => {
      if (object instanceof THREE.Mesh) {
        object.geometry.dispose();
        const disposeMaterial = (item: THREE.Material) => {
          (item as THREE.Material & { map?: THREE.Texture | null }).map?.dispose();
          item.dispose();
        };
        if (Array.isArray(object.material)) object.material.forEach(disposeMaterial);
        else disposeMaterial(object.material);
      } else if (object instanceof THREE.Sprite) {
        object.material.map?.dispose();
        object.material.dispose();
      }
    });
  }
}

function buildPapers(parent: THREE.Group, lots: TableLot[]): void {
  clearGroup(parent);
  const file = material(0x5a352c, 0.72);
  const paper = material(0xe4d8bc, 0.96);
  const ink = material(0x514b3d, 0.95);
  const wax = material(0x9d3e2f, 0.3);
  addMesh(parent, new THREE.BoxGeometry(2.28, 0.12, 1.6), file, [0, 0.04, 0], [0, -0.08, 0]);
  addMesh(parent, new THREE.BoxGeometry(2.22, 0.025, 1.52), paper, [0, 0.115, 0.02], [0, -0.08, 0]);
  for (let line = 0; line < 4; line += 1) {
    addMesh(parent, new THREE.BoxGeometry(0.92 + (line % 2) * 0.25, 0.007, 0.018), ink, [-0.28, 0.132, -0.38 + line * 0.17], [0, -0.08, 0]);
  }
  addMesh(parent, new THREE.CylinderGeometry(0.13, 0.13, 0.06, 20), wax, [0.73, 0.17, 0.34]);
  addMesh(parent, new THREE.TorusGeometry(0.15, 0.018, 6, 20), material(0xd6b36f, 0.28, 0.5), [0.73, 0.205, 0.34], [Math.PI / 2, 0, 0]);

  const count = Math.max(3, Math.min(lots.length, 6));
  for (let i = 0; i < count; i += 1) {
    const angle = (i / count) * Math.PI * 2;
    const card = new THREE.Group();
    card.position.set(Math.cos(angle) * 1.43, 0.1, Math.sin(angle) * 0.92);
    card.rotation.y = angle * 0.18;
    parent.add(card);
    const open = lots[i]?.status === "open";
    addMesh(card, new THREE.BoxGeometry(0.72, 0.035, 0.5), open ? paper : material(0xb8ad96, 0.95), [0, 0, 0]);
    if (lots[i]) {
      const label = new THREE.Mesh(new THREE.PlaneGeometry(0.64, 0.43), new THREE.MeshBasicMaterial({
        map: makePaperTexture(lots[i]!.nameAr, lots[i]!.id ? `ملف ${lots[i]!.id}` : "وثيقة من ملف الميراث"),
        transparent: false,
        side: THREE.DoubleSide,
        toneMapped: false,
      }));
      label.rotation.x = -Math.PI / 2;
      label.position.y = 0.02;
      label.receiveShadow = true;
      card.add(label);
    }
    addMesh(card, new THREE.CylinderGeometry(0.055, 0.055, 0.022, 12), material(open ? 0xb08b4f : 0x70685a, 0.34, 0.35), [0.25, 0.03, 0.16]);
  }
}

function buildHandCards(player: AvatarModel | undefined, localHand: number[], localHandLabels: string[]): void {
  if (!player) return;
  const fan = player.cardFan;
  const back = material(0x284c3f, 0.55);
  const front = material(0xe6d9ba, 0.9);
  const gold = material(0xc69d59, 0.3, 0.4);
  const cardCount = Math.max(3, Math.min(localHand.length || 3, 5));
  for (let i = 0; i < cardCount; i += 1) {
    const card = new THREE.Group();
    const spread = (i - (cardCount - 1) / 2) * 0.29;
    card.position.set(spread, 0.01 + Math.abs(spread) * 0.08, Math.abs(spread) * 0.16);
    card.rotation.y = spread * 0.8;
    fan.add(card);
    addMesh(card, new THREE.BoxGeometry(0.49, 0.035, 0.68), player.seat.isYou ? front : back, [0, 0, 0]);
    addMesh(card, new THREE.BoxGeometry(0.36, 0.01, 0.54), player.seat.isYou ? back : gold, [0, 0.024, 0]);
    addMesh(card, new THREE.CylinderGeometry(0.07, 0.07, 0.018, 12), gold, [0, 0.04, 0]);
    if (player.seat.isYou && localHand[i] !== undefined) {
      const face = new THREE.Mesh(new THREE.PlaneGeometry(0.41, 0.6), new THREE.MeshBasicMaterial({
        map: makePaperTexture(localHandLabels[i] ?? `بطاقة ${localHand[i]}`, `كارت ${String(localHand[i]).padStart(2, "0")}`),
        side: THREE.DoubleSide,
        toneMapped: false,
      }));
      face.rotation.x = -Math.PI / 2;
      face.position.y = 0.022;
      card.add(face);
    }
  }
}

export function TableScene(props: {
  players: TableSeat[];
  lots?: TableLot[];
  localPlayerId?: string | undefined;
  localHand?: number[];
  localHandLabels?: string[];
  poses: Record<string, TablePose>;
  onPose: (change: TablePoseChange) => void;
  cinematic?: boolean;
  interactive?: boolean;
}) {
  const mountRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const propsRef = useRef(props);
  const [webglUnavailable, setWebglUnavailable] = useState(false);
  propsRef.current = props;

  useEffect(() => {
    const mount = mountRef.current;
    const canvas = canvasRef.current;
    if (!mount || !canvas) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "low-power" });
    } catch {
      setWebglUnavailable(true);
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.6));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    const { scene, camera, tableItems, avatars } = createScene(renderer);
    const avatarModels = new Map<string, AvatarModel>();
    let lastPlayerSignature = "";
    let lastPaperSignature = "";
    let lastHandSignature = "";
    let frame = 0;
    let dragging = false;
    let pointerX = 0;
    let pointerY = 0;
    let orbit = 0;
    let polar = 0.69;
    let radius = 20.8;
    const target = new THREE.Vector3(0, 0.92, 0);
    const clock = new THREE.Clock();

    const resize = () => {
      const width = Math.max(1, mount.clientWidth);
      const height = Math.max(1, mount.clientHeight);
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(mount);
    resize();

    const onPointerDown = (event: PointerEvent) => {
      dragging = true;
      pointerX = event.clientX;
      pointerY = event.clientY;
      canvas.setPointerCapture(event.pointerId);
      canvas.classList.add("is-dragging");
    };
    const onPointerMove = (event: PointerEvent) => {
      if (!dragging || propsRef.current.cinematic) return;
      const dx = event.clientX - pointerX;
      const dy = event.clientY - pointerY;
      orbit -= dx * 0.006;
      polar = THREE.MathUtils.clamp(polar - dy * 0.004, 0.42, 1.02);
      pointerX = event.clientX;
      pointerY = event.clientY;
    };
    const onPointerUp = () => {
      dragging = false;
      canvas.classList.remove("is-dragging");
    };
    const onWheel = (event: WheelEvent) => {
      if (propsRef.current.cinematic) return;
      event.preventDefault();
      radius = THREE.MathUtils.clamp(radius + event.deltaY * 0.012, 16, 26);
    };
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointercancel", onPointerUp);
    canvas.addEventListener("wheel", onWheel, { passive: false });

    const rebuildAvatars = () => {
      clearGroup(avatars);
      avatarModels.clear();
      const current = propsRef.current;
      const players = current.players.slice(0, 12);
      const total = Math.max(4, players.length);
      const localIndex = Math.max(0, players.find((player) => player.playerId === current.localPlayerId)?.seatIndex ?? 0);
      for (let i = 0; i < players.length; i += 1) {
        const seat = players[i]!;
        const model = buildAvatar(seat, i, total, localIndex);
        avatars.add(model.root);
        avatarModels.set(seat.playerId, model);
        buildHandCards(model, current.localHand ?? [], current.localHandLabels ?? []);
      }
    };

    const animate = () => {
      frame = window.requestAnimationFrame(animate);
      const delta = Math.min(clock.getDelta(), 0.04);
      const elapsed = clock.elapsedTime;
      const current = propsRef.current;

      const playerSignature = current.players.map((player) => `${player.playerId}:${player.seatIndex}`).join("|") + `:${current.localPlayerId ?? ""}`;
      if (playerSignature !== lastPlayerSignature) {
        lastPlayerSignature = playerSignature;
        rebuildAvatars();
        lastHandSignature = (current.localHand ?? []).join(",");
      }
      const paperSignature = (current.lots ?? []).map((lot) => `${lot.nameAr}:${lot.status}`).join("|");
      if (paperSignature !== lastPaperSignature) {
        lastPaperSignature = paperSignature;
        buildPapers(tableItems, current.lots ?? []);
      }
      const handSignature = (current.localHand ?? []).join(",");
      if (handSignature !== lastHandSignature && current.localPlayerId) {
        lastHandSignature = handSignature;
        rebuildAvatars();
        lastPlayerSignature = playerSignature;
      }

      for (const avatar of avatarModels.values()) {
        const pose = current.poses[avatar.playerId];
        const lookAt = pose?.lookAt ?? { kind: "center" as const };
        let gaze = new THREE.Vector3(0, 1.25, 0);
        if (lookAt.kind === "documents") gaze = new THREE.Vector3(-0.8, 1.34, 0.18);
        if (lookAt.kind === "cards") gaze = avatar.root.localToWorld(new THREE.Vector3(0, 0.72, 0.85));
        if (lookAt.kind === "left" || lookAt.kind === "right") {
          const direction = lookAt.kind === "left" ? -1 : 1;
          const seatCount = Math.max(4, current.players.length);
          const adjacentSeat = (avatar.seat.seatIndex + direction + seatCount) % seatCount;
          const neighbor = [...avatarModels.values()].find((other) => other.seat.seatIndex === adjacentSeat);
          gaze = neighbor
            ? neighbor.root.position.clone().add(new THREE.Vector3(0, 1.78, 0))
            : avatar.root.localToWorld(new THREE.Vector3(direction * 4, 1.65, 0.75));
        }
        else if (lookAt.kind === "player") {
          const other = avatarModels.get(lookAt.playerId);
          if (other) gaze = other.root.position.clone().add(new THREE.Vector3(0, 1.78, 0));
        }
        avatar.root.updateMatrixWorld(true);
        const localGaze = avatar.root.worldToLocal(gaze.clone());
        const targetYaw = THREE.MathUtils.clamp(Math.atan2(localGaze.x, localGaze.z), -0.82, 0.82);
        const targetPitch = THREE.MathUtils.clamp(-Math.atan2(localGaze.y - 1.62, Math.max(0.2, Math.hypot(localGaze.x, localGaze.z))), -0.45, 0.45);
        const gesture = pose && Date.now() - pose.updatedAt < 4200 ? pose.gesture : null;
        const wave = gesture === "wave" ? Math.sin(elapsed * 9) * 0.4 : 0;
        const idleGlance = gesture ? 0 : avatar.index % 6 === 3 || avatar.index % 6 === 4
          ? Math.sin(elapsed * (avatar.index % 2 ? 0.48 : 0.7) + avatar.index) * 0.2
          : avatar.index % 6 === 5 ? Math.sin(elapsed * 0.4 + avatar.index) * 0.08 : 0;
        let leftZ = 0;
        let rightZ = 0;
        let leftX = 0.1;
        let rightX = 0.1;
        if (!gesture && avatar.index % 6 === 1) leftX += Math.max(0, Math.sin(elapsed * 1.5 + avatar.index)) * 0.12;
        if (!gesture && avatar.index % 6 === 2) rightX += Math.max(0, Math.sin(elapsed * 2.4 + avatar.index)) * 0.16;
        if (!gesture && avatar.index % 6 === 4) leftZ = Math.sin(elapsed * 0.9 + avatar.index) * 0.11;
        if (!gesture && avatar.index % 6 === 5) rightZ = Math.sin(elapsed * 0.7 + avatar.index) * 0.1;
        if (gesture === "wave") leftZ = -1.85;
        if (gesture === "point") { rightZ = 0.15; rightX = 1.28; }
        if (gesture === "thinking") { rightZ = 0.8; rightX = 1.55; }
        if (gesture === "shrug") { leftZ = -1.05; rightZ = 1.05; }
        if (gesture === "like") { rightZ = 0.25; rightX = 1.36; avatar.rightThumb.visible = true; }
        else avatar.rightThumb.visible = false;
        const lean = gesture === "point" ? 0.09 : gesture === "thinking" ? -0.025 : Math.sin(elapsed * 1.25 + avatar.index) * 0.012;
        if (gesture === "agree") avatar.head.rotation.x = THREE.MathUtils.lerp(avatar.head.rotation.x, Math.sin(elapsed * 8) * 0.16, delta * 8);
        else avatar.head.rotation.x = THREE.MathUtils.lerp(avatar.head.rotation.x, targetPitch, delta * 4.5);
        const disagreement = gesture === "disagree" ? Math.sin(elapsed * 14) * 0.22 : 0;
        avatar.head.rotation.y = THREE.MathUtils.lerp(avatar.head.rotation.y, targetYaw + idleGlance + disagreement, delta * 4.5);
        avatar.torso.position.y = 0.83 + Math.sin(elapsed * 1.7 + avatar.index) * 0.025;
        avatar.torso.rotation.x = THREE.MathUtils.lerp(avatar.torso.rotation.x, lean, delta * 4.5);
        avatar.leftArm.rotation.z = THREE.MathUtils.lerp(avatar.leftArm.rotation.z, leftZ + wave, delta * 7);
        avatar.rightArm.rotation.z = THREE.MathUtils.lerp(avatar.rightArm.rotation.z, rightZ, delta * 7);
        avatar.leftArm.rotation.x = THREE.MathUtils.lerp(avatar.leftArm.rotation.x, leftX, delta * 7);
        avatar.rightArm.rotation.x = THREE.MathUtils.lerp(avatar.rightArm.rotation.x, rightX, delta * 7);
        avatar.rightArm.rotation.y = THREE.MathUtils.lerp(avatar.rightArm.rotation.y, gesture === "point" ? targetYaw : 0, delta * 6);
        const holdingCards = Boolean(pose?.showCards);
        const cardPosition = holdingCards ? new THREE.Vector3(0, 0.98, -0.03) : new THREE.Vector3(0, 1.4, -1.22);
        avatar.cardFan.position.lerp(cardPosition, Math.min(1, delta * 5));
        const cardRotation = holdingCards ? -Math.PI / 2 : 0;
        avatar.cardFan.rotation.x = THREE.MathUtils.lerp(avatar.cardFan.rotation.x, cardRotation, Math.min(1, delta * 5));
        avatar.root.rotation.y = avatar.baseYaw;
      }

      if (current.cinematic) {
        orbit = Math.sin(elapsed * 0.18) * 0.28;
        polar = 0.73 + Math.sin(elapsed * 0.12) * 0.045;
        radius = 20.8 - Math.sin(elapsed * 0.15) * 0.55;
      }
      camera.position.set(
        target.x + radius * Math.sin(polar) * Math.sin(orbit),
        target.y + radius * Math.cos(polar),
        target.z + radius * Math.sin(polar) * Math.cos(orbit),
      );
      camera.lookAt(target);
      renderer.render(scene, camera);
    };
    animate();

    return () => {
      window.cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerUp);
      canvas.removeEventListener("wheel", onWheel);
      scene.traverse((object) => {
        if (object instanceof THREE.Mesh) {
          object.geometry.dispose();
          if (Array.isArray(object.material)) object.material.forEach((item) => item.dispose());
          else object.material.dispose();
        } else if (object instanceof THREE.Sprite) {
          object.material.map?.dispose();
          object.material.dispose();
        }
      });
      renderer.dispose();
    };
  }, []);

  const invoke = (change: TablePoseChange) => props.onPose(change);
  const [selectedPlayer, setSelectedPlayer] = useState("");

  return (
    <section className={`table-scene-card ${props.cinematic ? "table-scene-cinematic" : ""}`} aria-label="مشهد مجلس الورثة ثلاثي الأبعاد">
      <div className="table-scene-canvas-wrap" ref={mountRef}>
        <canvas ref={canvasRef} aria-label="طاولة الميراث والشخصيات الجالسة حولها" />
        {webglUnavailable && (
          <div className="scene-fallback" role="img" aria-label="تصوير مبسط لطاولة المجلس">
            <div className="fallback-table"><span>ملفّ التركة</span><i>✦</i></div>
            {props.players.map((player, index) => <span className={`fallback-seat seat-${index % 6}`} key={player.playerId} style={{ "--seat-color": roundedColor(index) } as CSSProperties}>{player.displayName.slice(0, 1)}</span>)}
          </div>
        )}
        {!props.cinematic && <div className="scene-compass" aria-hidden="true"><span>اسحب لتدوير الكاميرا</span><b>↻</b></div>}
      </div>
      {!props.cinematic && props.interactive !== false && (
        <div className="scene-controls">
          <div className="scene-control-row">
            <span className="scene-control-label">وجّه نظرك إلى</span>
            <button type="button" onClick={() => invoke({ lookAt: { kind: "center" } })}>الطاولة</button>
            <button type="button" onClick={() => invoke({ lookAt: { kind: "documents" } })}>الملف</button>
            <button type="button" onClick={() => invoke({ lookAt: { kind: "cards" } })}>أوراقك</button>
            <button type="button" onClick={() => invoke({ lookAt: { kind: "left" } })}>يسارك</button>
            <button type="button" onClick={() => invoke({ lookAt: { kind: "right" } })}>يمينك</button>
            {props.players.length > 1 && <label className="scene-target-select"><span className="sr-only">انظر إلى لاعب</span><select value={selectedPlayer} onChange={(event) => { setSelectedPlayer(event.target.value); if (event.target.value) invoke({ lookAt: { kind: "player", playerId: event.target.value } }); }}><option value="">لاعب بجوارك</option>{props.players.filter((player) => !player.isYou).map((player) => <option key={player.playerId} value={player.playerId}>{player.displayName}</option>)}</select></label>}
          </div>
          <div className="scene-control-row scene-gesture-row">
            <span className="scene-control-label">حركة الشخصية</span>
            {(Object.keys(gestureLabels) as TableGesture[]).map((gesture) => <button key={gesture} type="button" onClick={() => invoke({ gesture })}>{gestureLabels[gesture]}</button>)}
            <button type="button" aria-pressed={Boolean(props.poses[props.localPlayerId ?? ""]?.showCards)} onClick={() => invoke({ showCards: !props.poses[props.localPlayerId ?? ""]?.showCards })}>{props.poses[props.localPlayerId ?? ""]?.showCards ? "رجّع كروتك للطاولة" : "ارفع كروتك في إيدك"}</button>
          </div>
          <div className="scene-players" aria-label="شخصيات المجلس">
            {props.players.map((player, index) => {
              const role = characterRoles[player.seatIndex % characterRoles.length]!;
              const pose = props.poses[player.playerId];
              return <button className={`scene-player-chip ${player.isYou ? "is-you" : ""} ${player.connected ? "" : "is-offline"}`} key={player.playerId} type="button" onClick={() => { setSelectedPlayer(player.playerId); invoke({ lookAt: { kind: "player", playerId: player.playerId } }); }} title={`انظر إلى ${player.displayName}`}>
                <span className="scene-player-dot" style={{ "--seat-color": roundedColor(index) } as CSSProperties}>{player.displayName.slice(0, 1)}</span>
                <span className="scene-player-text"><b>{player.displayName}{player.isYou ? " · أنت" : ""}</b><small>{role}{pose?.gesture ? ` · ${gestureLabels[pose.gesture]}` : ""}</small></span>
              </button>;
            })}
          </div>
        </div>
      )}
    </section>
  );
}
