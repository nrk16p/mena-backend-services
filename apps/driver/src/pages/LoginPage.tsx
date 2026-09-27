import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError, login } from '@shared/api';

export default function LoginPage() {
  const nav = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await login(username, password);
      nav('/');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'เข้าสู่ระบบไม่สำเร็จ');
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="flex min-h-screen flex-col justify-center gap-4 p-6">
      <h1 className="text-center text-2xl font-semibold">Mena TMS — พนักงานขับรถ</h1>
      <div className="space-y-1">
        <Label htmlFor="u">ชื่อผู้ใช้</Label>
        <Input id="u" className="h-12 text-lg" value={username} onChange={(e) => setUsername(e.target.value)} autoCapitalize="none" />
      </div>
      <div className="space-y-1">
        <Label htmlFor="p">รหัสผ่าน</Label>
        <Input id="p" type="password" className="h-12 text-lg" value={password} onChange={(e) => setPassword(e.target.value)} />
      </div>
      <Button type="submit" className="h-12 text-lg" disabled={busy || !username || !password}>
        เข้าสู่ระบบ
      </Button>
    </form>
  );
}
