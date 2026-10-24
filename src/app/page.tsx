import { Explorer } from "@/components/Explorer";
import { Footer } from "@/components/Footer";
import { HowItWorks } from "@/components/HowItWorks";
import { currentModes } from "@/lib/agent/run";
import { CITIES } from "@/lib/qloo/mock-data";

export default function Home() {
  // Only mode names and the call budget reach the browser, never keys.
  const modes = currentModes();
  return (
    <>
      <Explorer cities={CITIES} modes={modes} />
      <HowItWorks modes={modes} />
      <Footer modes={modes} />
    </>
  );
}
