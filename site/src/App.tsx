import { Nav } from './components/Nav'
import { Hero } from './components/Hero'
import { Highlights } from './components/Highlights'
import { Pipeline } from './components/Pipeline'
import { Features } from './components/Features'
import { Installation } from './components/Installation'
import { Usage } from './components/Usage'
import { Footer } from './components/Footer'

export default function App() {
  return (
    <div style={{ background: '#020205', minHeight: '100vh' }}>
      <Nav />
      <main>
        <Hero />
        <Highlights />
        <Pipeline />
        <Features />
        <Installation />
        <Usage />
      </main>
      <Footer />
    </div>
  )
}
