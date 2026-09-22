export function buildEml(input: { to: string; subject: string; body: string }): Buffer {
  const clean = (s: string) => s.replace(/[\r\n]+/g, ' ').trim();
  const encodedSubject = `=?UTF-8?B?${Buffer.from(clean(input.subject)).toString('base64')}?=`;
  const lines = [
    `To: ${clean(input.to)}`, `Subject: ${encodedSubject}`, 'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: quoted-printable', '',
    input.body.replace(/=/g, '=3D').replace(/[^\x20-\x7E\r\n]/g, (ch) =>
      [...Buffer.from(ch)].map((b) => `=${b.toString(16).toUpperCase().padStart(2, '0')}`).join('')),
  ];
  return Buffer.from(lines.join('\r\n'));
}
