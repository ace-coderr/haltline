import { lazy, Suspense } from 'react'
import { Route, Routes } from 'react-router-dom'
import { Layout } from './components/Layout.tsx'
import { Spinner } from './components/ui.tsx'
import Home from './pages/Home.tsx'

const HowItWorks = lazy(() => import('./pages/HowItWorks.tsx'))
const Limits = lazy(() => import('./pages/Limits.tsx'))
const Positions = lazy(() => import('./pages/Positions.tsx'))
const Activity = lazy(() => import('./pages/Activity.tsx'))
const Safety = lazy(() => import('./pages/Safety.tsx'))
const Pair = lazy(() => import('./pages/Pair.tsx'))
const Docs = lazy(() => import('./pages/Docs.tsx'))
const NotFound = lazy(() => import('./pages/NotFound.tsx'))

export default function App() {
  return (
    <Suspense fallback={<div className="wrap"><Spinner /></div>}>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Home />} />
          <Route path="how-it-works" element={<HowItWorks />} />
          <Route path="limits" element={<Limits />} />
          <Route path="positions" element={<Positions />} />
          <Route path="activity" element={<Activity />} />
          <Route path="safety" element={<Safety />} />
          <Route path="pair" element={<Pair />} />
          <Route path="docs" element={<Docs />} />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </Suspense>
  )
}
