import NavBar from "@/components/NavBar";
import Hero from "@/components/Hero";
import Features from "@/components/Features";
import Pipeline from "@/components/Pipeline";
import Commands from "@/components/Commands";
import Install from "@/components/Install";
import Footer from "@/components/Footer";

export default function Home() {
  return (
    <>
      <NavBar />
      <main>
        <Hero />
        <Features />
        <Pipeline />
        <Commands />
        <Install />
      </main>
      <Footer />
    </>
  );
}
