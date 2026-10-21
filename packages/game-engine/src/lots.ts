import type { LotDefinition } from "./types.js";

/**
 * Configurable MVP catalog. Each round draws from this 12-record deck and the
 * deck is reshuffled when its current cycle runs out; no lot repeats in a cycle.
 */
export const LOT_CATALOG: readonly LotDefinition[] = [
  { id: "A", nameAr: "خزانة الوصايا", nameEn: "The Will Vault", rewardType: "influence", rewardAmount: 1 },
  { id: "B", nameAr: "ديوان الأختام", nameEn: "Hall of Seals", rewardType: "draw-card", rewardAmount: 1 },
  { id: "C", nameAr: "الرواق الحجري", nameEn: "The Marble Gallery", rewardType: "remove-suspicion", rewardAmount: 1 },
  { id: "D", nameAr: "المكتب الشرقي", nameEn: "The East Office", rewardType: "influence", rewardAmount: 1 },
  { id: "E", nameAr: "قاعة السجلات", nameEn: "Records Hall", rewardType: "draw-card", rewardAmount: 1 },
  { id: "F", nameAr: "الحديقة الداخلية", nameEn: "The Inner Garden", rewardType: "remove-suspicion", rewardAmount: 1 },
  { id: "G", nameAr: "المخزن القديم", nameEn: "The Old Archive", rewardType: "influence", rewardAmount: 1 },
  { id: "H", nameAr: "غرفة المراسلات", nameEn: "The Correspondence Room", rewardType: "draw-card", rewardAmount: 1 },
  { id: "I", nameAr: "الشرفة العليا", nameEn: "The Upper Gallery", rewardType: "remove-suspicion", rewardAmount: 1 },
  { id: "J", nameAr: "ممر العائلة", nameEn: "The Family Passage", rewardType: "influence", rewardAmount: 1 },
  { id: "K", nameAr: "خزانة الخرائط", nameEn: "The Map Cabinet", rewardType: "draw-card", rewardAmount: 1 },
  { id: "L", nameAr: "المصلى المهجور", nameEn: "The Quiet Chapel", rewardType: "remove-suspicion", rewardAmount: 1 },
];
