export const money = (value) =>
  new Intl.NumberFormat('en-ZA', {
    style: 'currency',
    currency: 'ZAR',
    maximumFractionDigits: 2,
  }).format(Number(value || 0));

export const clock = (value) => {
  if (!value) return '—';
  return new Intl.DateTimeFormat('en-ZA', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Africa/Johannesburg',
  }).format(new Date(value));
};

export const dateTime = (value) => {
  if (!value) return '—';
  return new Intl.DateTimeFormat('en-ZA', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Africa/Johannesburg',
  }).format(new Date(value));
};

export const elapsed = (value) => {
  if (!value) return 'just now';
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
};

export const remaining = (value) => {
  if (!value) return null;
  const seconds = Math.floor((new Date(value).getTime() - Date.now()) / 1000);
  if (seconds <= 0) return 'window ended';
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes}m left`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m left`;
};

export const label = (value = '') =>
  String(value || '')
    .replaceAll('_', ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());

export const cleanPhone = (value = '') => String(value || '').replace(/[^\d+]/g, '');

export const whatsappUrl = (value, text = '') => {
  let phone = cleanPhone(value);
  if (!phone) return null;
  if (phone.startsWith('0')) phone = `27${phone.slice(1)}`;
  phone = phone.replace(/^\+/, '');
  return `https://wa.me/${phone}${text ? `?text=${encodeURIComponent(text)}` : ''}`;
};

export const callUrl = (value) => {
  const phone = cleanPhone(value);
  return phone ? `tel:${phone}` : null;
};

export const humanizeError = (error) => {
  const raw = error?.message || String(error || 'Something went wrong.');
  const known = [
    ['Failed to fetch', 'The Control Centre could not reach Supabase. Check the internet connection and try again.'],
    ['JWT expired', 'Your session expired. Sign in again.'],
    ['Invalid login credentials', 'The email or password is incorrect.'],
    ['Driver capacity would be exceeded', 'That driver does not have enough bucket capacity for this order.'],
    ['Waiting for a confirmed customer location', 'Confirm the customer’s delivery pin before assigning a driver.'],
    ['Location must be confirmed', 'Confirm the customer’s delivery pin before assigning a driver.'],
    ['Resolve Needs help before approving payment', 'Resolve the order in Needs help before approving its payment.'],
    ['Order needs human help', 'Resolve the order in Needs help before assigning a driver.'],
    ['Order is not paid', 'The customer must complete payment before a driver can receive this order.'],
  ];
  const match = known.find(([needle]) => raw.includes(needle));
  return match ? match[1] : raw;
};
