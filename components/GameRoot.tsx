"use client";
import { useGame } from "@/state/store";
import MenuScreen from "./screens/MenuScreen";
import CommandScreen from "./screens/CommandScreen";
import BriefingScreen from "./screens/BriefingScreen";
import TacticalScreen from "./screens/TacticalScreen";
import AfterActionScreen from "./screens/AfterActionScreen";
import TourEndScreen from "./screens/TourEndScreen";
import TutorialCoach from "./TutorialCoach";

export default function GameRoot() {
  const screen = useGame((s) => s.screen);
  return (
    <main className="w-screen h-screen overflow-hidden bg-bg text-ink relative">
      {screen === "menu" && <MenuScreen />}
      {screen === "command" && <CommandScreen />}
      {screen === "briefing" && <BriefingScreen />}
      {screen === "tactical" && <TacticalScreen />}
      {screen === "afteraction" && <AfterActionScreen />}
      {screen === "tourend" && <TourEndScreen />}
      <TutorialCoach />
    </main>
  );
}
