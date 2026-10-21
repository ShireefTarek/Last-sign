# 60-card implementation matrix

Status terms: `complete` in the Data column means the English source record is transcribed. The wired cards have Arabic UI text; remaining translations are pending. Resolver, UI, and test status reflects only verified behavior.

| ID | Card | Data | Resolver | UI/decision | Tests | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| 01 | Public Opening | complete | complete | complete | complete | |
| 02 | Conditional Contract | complete | pending | pending | pending | |
| 03 | Calculated Increase | complete | complete | complete | complete | |
| 04 | Loser's Insurance | complete | complete | complete | complete | |
| 05 | Half Price | complete | complete | complete | complete | Winner is not retroactively changed. |
| 06 | Trust Agent | complete | complete | complete | pending | |
| 07 | Debt of Fulfillment | complete | pending | pending | pending | |
| 08 | Broker's Commission | complete | complete | complete | complete | |
| 09 | Tiebreak Key | complete | pending | pending | pending | Explicit no-op when global tiebreak already decides or card cannot change result. |
| 10 | Heirs' Advance | complete | complete | complete | complete | |
| 11 | Renegotiation | complete | complete | complete | complete | Paid public declaration revision; original declaration is preserved for wagers and audit. |
| 12 | Shared Desire | complete | complete | complete | pending | |
| 13 | Auction Commission | complete | complete | complete | pending | Real competitors only. |
| 14 | Last Bid | complete | complete | complete | complete | |
| 15 | Measured Acceptance | complete | complete | complete | complete | Depends on crowding definition. |
| 16 | Double Intent | complete | complete | complete | pending | Depends on crowding definition. |
| 17 | Distraction Envelope | complete | pending | pending | pending | Phantom affects only explicit competitor counts. |
| 18 | Masked Announcement | complete | complete | complete | complete | Declaration field hidden until wager lock. |
| 19 | Redirect | complete | pending | pending | pending | No-op without two announced lots. |
| 20 | Mirror of a Rival | complete | pending | pending | pending | Copies at most one eligible bid point. |
| 21 | Calculated Rumor | complete | complete | complete | complete | Target can be selected during negotiation; hidden public lot announcements make the card a no-op. |
| 22 | Contradictory Account | complete | complete | complete | complete | Contradiction grants +1 effective bid and adds 1 suspicion. |
| 23 | Missing Slip | complete | complete | complete | complete | Hides exactly one declaration field. |
| 24 | Alternate Copy | complete | pending | pending | pending | Depends on crowding definition. |
| 25 | Echo of Words | complete | complete | complete | complete | Repeats only the target's visible declaration fields. |
| 26 | False Mark | complete | complete | complete | complete | Transfers 1 suspicion and uses the normal 3-suspicion forced-announcement rule. |
| 27 | Late Correction | complete | pending | pending | pending | |
| 28 | Alternate List | complete | pending | pending | pending | Requires documented lot deck. |
| 29 | Illusion Seal | complete | pending | pending | pending | |
| 30 | Side Window | complete | pending | pending | pending | Depends on crowding definition. |
| 31 | Contradiction Fee | complete | complete | complete | complete | Changed target gains suspicion; unchanged target makes owner pay 1 available influence. |
| 32 | Clock Scorpion | complete | complete | complete | complete | Adds 2 scandal; final-round scheduling checks the end-of-round value. |
| 33 | Public Audit | complete | pending | pending | pending | Target chooses a card; bounded response required. |
| 34 | Auction Tax | complete | pending | pending | pending | |
| 35 | Crowd Pressure | complete | complete | complete | complete | On the most crowded lot, every real competitor loses 1 effective bid; scandal rises once. |
| 36 | Bad Reputation | complete | pending | pending | pending | |
| 37 | Harsh Condition | complete | complete | complete | complete | Targets a declared lot. Affected players can satisfy it with base bid ≥1; otherwise pay 1 available influence, including on pass. |
| 38 | Reveal the Stance | complete | pending | pending | pending | |
| 39 | Message of Threat | complete | pending | pending | pending | Target chooses cost or one-card reveal. |
| 40 | Influence Invoice | complete | complete | complete | complete | Checks remaining influence after committed bid and other costs; charges once per player. |
| 41 | Spotlight | complete | pending | pending | pending | |
| 42 | Vault Inspection | complete | pending | pending | pending | Target chooses cost or category reveal. |
| 43 | Cumulative Scandal | complete | complete | complete | complete | Adds 2 when scandal was at least 6 before this effect; round-end check follows. |
| 44 | Narrow the Contest | complete | pending | pending | pending | |
| 45 | Final Warning | complete | pending | pending | pending | Target chooses cost or suspicion. |
| 46 | Wax Seal | complete | pending | pending | pending | First eligible targeted effect only. |
| 47 | Documented Record | complete | complete | complete | complete | Removes 1 suspicion, or gains 1 influence when suspicion is 0. |
| 48 | Loser Guarantee | complete | complete | complete | complete | Same one-point refund as card 04; mutually exclusive card slot prevents stacking. |
| 49 | Orderly Withdrawal | complete | pending | pending | pending | Recompute before seal distribution. |
| 50 | Heir's Umbrella | complete | pending | pending | pending | |
| 51 | Back Door | complete | pending | pending | pending | No-op without a legal card-driven lot change. |
| 52 | Return the Blow | complete | pending | pending | pending | Reflected effects cannot loop. |
| 53 | Seal Insurance | complete | pending | pending | pending | Preserve no-op unless a legal card can remove a seal. |
| 54 | Emergency Fund | complete | complete | complete | complete | Gains 1 influence when the owner wins no lot. |
| 55 | Void Signature | complete | pending | pending | pending | Preserve breach event and return escrow. |
| 56 | Short Truce | complete | complete | complete | complete | Reduces scandal by 1 and adds 1 suspicion before the round-end check. |
| 57 | Archive Immunity | complete | pending | pending | pending | |
| 58 | Deferred Account | complete | pending | pending | pending | Visible deferred effect, never delayed twice. |
| 59 | Mutual Rescue | complete | pending | pending | pending | |
| 60 | Last Page | complete | pending | pending | pending | Final round only. |
