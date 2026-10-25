import { connection } from "next/server";
import { Explorer } from "@/components/Explorer";
import { Footer } from "@/components/Footer";
import { hasExample, HowItWorks } from "@/components/HowItWorks";
import { currentModes } from "@/lib/agent/run";
import { CITIES } from "@/lib/qloo/mock-data";

// The modes come from the server's environment at request time, so the whole page waits for the
// request rather than shipping a shell prerendered with the build machine's settings.
export const instant = false;

export default async function Home() {
  // Without this, Cache Components prerenders the page at build time and freezes the modes.
  await connection();
  // Only mode names, the call budget and whether live runs are off reach the browser, never keys.
  const modes = currentModes();
  return (
    <>
      <Explorer cities={CITIES} modes={modes} hasExample={hasExample()} />
      <HowItWorks modes={modes} />
      <Footer modes={modes} />
    </>
  );
}
