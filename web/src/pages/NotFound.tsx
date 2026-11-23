import { Link } from 'react-router-dom'
import { PageHead } from '../components/ui.tsx'

export default function NotFound() {
  return (
    <>
      <PageHead title="Page not found" lead="That page does not exist. Try one of these." />
      <div className="wrap hero-cta">
        <Link to="/" className="btn btn-primary">Home</Link>
        <Link to="/how-it-works" className="btn">How it works</Link>
        <Link to="/pair" className="btn">Pair a device</Link>
      </div>
    </>
  )
}
