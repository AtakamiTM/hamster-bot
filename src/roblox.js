const TIMEOUT = 8000;
const UA = { 'user-agent': 'HamsterBot/1.0 (Discord community bot)' };

export const isValidUsername = (name) => /^[A-Za-z0-9_]{3,20}$/.test(name);

export async function findUser(username) {
  const res = await fetch('https://users.roblox.com/v1/usernames/users', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...UA },
    body: JSON.stringify({ usernames: [username], excludeBannedUsers: true }),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!res.ok) throw new Error(`Roblox lookup failed (${res.status})`);
  const { data } = await res.json();
  return data?.[0] ?? null;
}

export async function getProfile(userId) {
  const res = await fetch(`https://users.roblox.com/v1/users/${userId}`, {
    headers: UA,
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!res.ok) throw new Error(`Roblox profile failed (${res.status})`);
  return res.json();
}

export async function getHeadshot(userId) {
  try {
    const res = await fetch(
      `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${userId}&size=150x150&format=Png&isCircular=false`,
      { headers: UA, signal: AbortSignal.timeout(TIMEOUT) },
    );
    const json = await res.json();
    return json.data?.[0]?.imageUrl ?? null;
  } catch {
    return null;
  }
}
