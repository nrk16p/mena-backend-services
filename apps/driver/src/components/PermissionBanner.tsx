import { useEffect, useState } from 'react';
import { gpsState, type GpsState } from '../lib/permissions';

export default function PermissionBanner() {
  const [gps, setGps] = useState<GpsState>('prompt');
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    void gpsState().then(setGps);
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    const t = setInterval(() => void gpsState().then(setGps), 15_000);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
      clearInterval(t);
    };
  }, []);
  return (
    <div className="sticky top-0 z-10">
      {(gps === 'denied' || gps === 'unsupported') && (
        <div className="bg-red-600 px-4 py-2 text-sm text-white">
          ปิดตำแหน่ง (GPS) อยู่ — เปิดที่ ตั้งค่า › เบราว์เซอร์ › ตำแหน่ง แล้วเปิดแอปใหม่ (ยังกดงานได้ แต่จะถูกบันทึกว่าไม่มี GPS)
        </div>
      )}
      {!online && <div className="bg-amber-500 px-4 py-2 text-sm text-white">ไม่มีสัญญาณอินเทอร์เน็ต — กดซ้ำได้เมื่อสัญญาณกลับมา</div>}
    </div>
  );
}
