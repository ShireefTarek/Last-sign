import { expect, test } from "@playwright/test";

test("friends create and join the same live room on a mobile viewport", async ({ browser }) => {
  const hostContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const guestContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const host = await hostContext.newPage();
  const guest = await guestContext.newPage();

  await host.goto("/");
  await host.getByLabel("اسمك على سجل الورثة").fill("المضيف");
  await host.getByRole("button", { name: /إنشاء غرفة جديدة/ }).click();
  await expect(host.getByText("أهل المجلس")).toBeVisible();
  const roomCode = await host.locator(".room-code-card strong").textContent();
  expect(roomCode).toMatch(/^[A-Z2-9]{6}$/);

  await guest.goto(`/join/${roomCode}`);
  await guest.getByLabel("اسمك على سجل الورثة").fill("ضيف");
  await guest.getByRole("button", { name: "انضم" }).click();
  await expect(guest.locator(".player-list .player-row").nth(1)).toContainText("ضيف");
  await expect(host.locator(".player-list .player-row").nth(1)).toContainText("ضيف");
  await expect(guest.getByRole("button", { name: "أنا مستعد" })).toBeEnabled();
  await guest.getByRole("button", { name: "أنا مستعد" }).click();
  await expect(guest.getByRole("button", { name: "✓ مستعد للعب" })).toBeVisible();

  await hostContext.close();
  await guestContext.close();
});
