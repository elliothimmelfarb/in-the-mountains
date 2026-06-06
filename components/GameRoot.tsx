"use client";
import { useGame } from "@/state/store";
import MenuScreen from "./screens/MenuScreen";
import LoadingScreen from "./screens/LoadingScreen";
import DeployScreen from "./screens/DeployScreen";
import TourEndScreen from "./screens/TourEndScreen";
import TutorialCoach from "./TutorialCoach";

export default function GameRoot() {
  const screen = useGame((s) => s.screen);
  return (
    <main className="w-screen h-screen overflow-hidden bg-bg text-ink relative">
      {screen === "menu" && <MenuScreen />}
      {screen === "loading" && <LoadingScreen />}
      {screen === "deploy" && <DeployScreen />}
      {screen === "tourend" && <TourEndScreen />}
      <TutorialCoach />
    </main>
  );
}
