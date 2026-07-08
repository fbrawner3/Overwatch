import { Toaster } from "@/components/ui/toaster"
import { BrowserRouter as Router, Route, Routes } from 'react-router-dom';
import PageNotFound from './lib/PageNotFound';
import { AppAuthProvider } from '@/lib/AuthContext';
import ScrollToTop from './components/ScrollToTop';
import HexMap from './pages/HexMap';

function App() {
  return (
    <AppAuthProvider>
      <Router>
        <ScrollToTop />
        <Routes>
          <Route path="/" element={<HexMap />} />
          <Route path="*" element={<PageNotFound />} />
        </Routes>
        <Toaster />
      </Router>
    </AppAuthProvider>
  )
}

export default App
