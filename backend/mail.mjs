// Отправка писем с кодами. Сейчас — через почту Яндекса (SMTP, пароль приложения).
// Переменные: SMTP_USER (адрес ящика), SMTP_PASS (пароль приложения), SMTP_HOST (по умолчанию smtp.yandex.ru).
// MAIL_MODE=capture — для проверок: письма складываются в globalThis.__outbox.
import nodemailer from 'nodemailer';

export function createMail(env) {
  if (env.MAIL_MODE === 'capture') {
    globalThis.__outbox = globalThis.__outbox || [];
    return { enabled: true, async send(to, subject, text) { globalThis.__outbox.push({ to, subject, text }); } };
  }
  if (!env.SMTP_USER || !env.SMTP_PASS) return { enabled: false, async send() { throw new Error('Почта не настроена'); } };
  const transport = nodemailer.createTransport({
    host: env.SMTP_HOST || 'smtp.yandex.ru', port: 465, secure: true,
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
    connectionTimeout: 8000, greetingTimeout: 8000, socketTimeout: 10000
  });
  return {
    enabled: true,
    async send(to, subject, text) {
      await transport.sendMail({ from: { name: env.MAIL_FROM_NAME || 'Цифровой набор для кафе', address: env.SMTP_USER }, to, subject, text });
    }
  };
}
