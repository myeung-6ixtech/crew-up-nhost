#!/usr/bin/env node
/**
 * Builds every Nhost Auth email template (nhost/emails/<locale>/<template>/body.html + subject.txt)
 * from one layout — design: "Email HTML Templates.dc.html" (Altitude: ink header and footer, lime button).
 *
 * Tables and inline styles only, Arial and Courier New (email clients drop web fonts), a VML button for
 * Outlook, and a dark-mode override block. English copy is the design's, word for word.
 *
 *   node scripts/build-emails.mjs           write every template
 *   node scripts/build-emails.mjs --check   exit 1 if any file on disk differs (CI)
 *
 * Nhost fills ${link}, ${email} and ${ticket} at send time. ${displayName} isn't used.
 * signin-passwordless-sms is plain-text SMS and is left alone.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'nhost', 'emails');
/** Hosted copy of nhost/emails/assets/crewup-wordmark-lime-2x.png. */
const WORDMARK_URL = 'https://crewup.app/email/crewup-wordmark-lime-2x.png';

// Nhost placeholders, written without `${` so they survive this file's own template literals.
const LINK = '$' + '{link}';
const EMAIL = '$' + '{email}';
const TICKET = '$' + '{ticket}';
const STRONG_EMAIL = `<strong style="color:#0E1113;">${EMAIL}</strong>`;

const PREHEADER_PAD = Array.from({ length: 40 }, () => '&#8199;&#847;').join(' ');

/** {email} in copy → the bold address in the body, or the plain one in the footer. */
const fillEmail = (text, strong) => text.split('{email}').join(strong ? STRONG_EMAIL : EMAIL);

function render(lang, common, copy, kind) {
  const action =
    kind === 'code'
      ? `            <table role="presentation" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td class="code" bgcolor="#EAECE5" style="background:#EAECE5; border-radius:14px; padding:16px 28px;">
                  <p class="ink" style="margin:0; font-family:'Courier New', Courier, monospace; font-size:30px; line-height:36px; mso-line-height-rule:exactly; font-weight:bold; letter-spacing:6px; color:#0E1113;">${TICKET}</p>
                </td>
              </tr>
            </table>`
      : `            <table role="presentation" class="btn" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td bgcolor="#A8E05F" style="background:#A8E05F; border-radius:28px;">
                  <!--[if mso]><v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" href="${LINK}" style="height:52px; v-text-anchor:middle; width:240px;" arcsize="50%" stroke="f" fillcolor="#A8E05F"><center style="color:#0E1113; font-family:Arial, sans-serif; font-size:16px; font-weight:bold;">${copy.cta}</center></v:roundrect><![endif]-->
                  <!--[if !mso]><!--><a href="${LINK}" target="_blank" style="display:inline-block; padding:16px 36px; font-family:Arial, Helvetica, sans-serif; font-size:16px; line-height:20px; font-weight:bold; color:#0E1113; text-decoration:none; border-radius:28px;">${copy.cta}</a><!--<![endif]-->
                </td>
              </tr>
            </table>`;

  // The code email has no link to fall back to, so it skips the rule and the "copy this link" lines.
  const fallback =
    kind === 'code'
      ? ''
      : `
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:28px;">
              <tr><td class="rule" style="border-top:1px solid #DDE1D6; font-size:0; line-height:0;">&nbsp;</td></tr>
            </table>
            <p class="muted" style="margin:20px 0 6px; font-family:Arial, Helvetica, sans-serif; font-size:13px; line-height:19px; mso-line-height-rule:exactly; color:#5F6559;">${common.linkHelp}</p>
            <p class="link" style="margin:0; font-family:'Courier New', Courier, monospace; font-size:12px; line-height:18px; mso-line-height-rule:exactly; word-break:break-all;"><a href="${LINK}" target="_blank" style="color:#4F6E19; text-decoration:underline;">${LINK}</a></p>`;

  const codeDark = kind === 'code' ? '\n    .code { background:#22282B !important; }' : '';

  return `<!DOCTYPE html>
<html lang="${lang}" xmlns="http://www.w3.org/1999/xhtml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${copy.subject}</title>
<!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><![endif]-->
<style>
  @media (max-width: 620px) {
    .px { padding-left: 24px !important; padding-right: 24px !important; }
    .h1 { font-size: 28px !important; line-height: 32px !important; }
    .btn a { display: block !important; text-align: center !important; }
  }
  @media (prefers-color-scheme: dark) {
    .bg { background: #0B0D0E !important; }
    .card { background: #171B1D !important; }
    .ink { color: #EDF1F2 !important; }
    .ink strong { color: #EDF1F2 !important; }
    .muted { color: #A7B1B5 !important; }
    .eyebrow { color: #A8E05F !important; }
    .link a { color: #A8E05F !important; }
    .rule { border-color: #2A3033 !important; }${codeDark}
  }
</style>
</head>
<body class="bg" style="margin:0; padding:0; background:#ECEEE8; -webkit-text-size-adjust:100%; -ms-text-size-adjust:100%;">
<div style="display:none; max-height:0; overflow:hidden; mso-hide:all; font-size:1px; line-height:1px; color:#ECEEE8; opacity:0;">${copy.preheader}${PREHEADER_PAD} </div>
<table role="presentation" class="bg" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#ECEEE8;">
  <tr>
    <td align="center" style="padding:32px 12px;">
      <!--[if mso]><table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;">
        <tr>
          <td class="px" bgcolor="#0E1113" style="background:#0E1113; border-radius:20px 20px 0 0; padding:32px 40px 30px;">
            <img src="${WORDMARK_URL}" width="148" height="42" alt="crewup" style="display:block; width:148px; height:auto; border:0; outline:none; text-decoration:none; font-family:Arial, Helvetica, sans-serif; font-size:30px; font-weight:bold; color:#A8E05F;">
          </td>
        </tr>
        <tr>
          <td class="card px" bgcolor="#FAFBF8" style="background:#FAFBF8; padding:40px 40px 36px;">
            <p class="eyebrow" style="margin:0 0 14px; font-family:'Courier New', Courier, monospace; font-size:12px; line-height:16px; mso-line-height-rule:exactly; letter-spacing:2px; font-weight:bold; color:#4F6E19;">${copy.eyebrow}</p>
            <h1 class="h1 ink" style="margin:0 0 16px; font-family:Arial, Helvetica, sans-serif; font-size:32px; line-height:36px; mso-line-height-rule:exactly; font-weight:bold; letter-spacing:-0.5px; color:#0E1113;">${copy.title}</h1>
            <p class="ink" style="margin:0 0 28px; font-family:Arial, Helvetica, sans-serif; font-size:16px; line-height:24px; mso-line-height-rule:exactly; color:#3D4239;">${fillEmail(copy.body, true)}</p>
${action}
            <p class="muted" style="margin:28px 0 0; font-family:Arial, Helvetica, sans-serif; font-size:14px; line-height:21px; mso-line-height-rule:exactly; color:#5F6559;">${copy.fine}</p>${fallback}
          </td>
        </tr>
        <tr>
          <td class="px" bgcolor="#0E1113" style="background:#0E1113; border-radius:0 0 20px 20px; padding:24px 40px 28px;">
            <p style="margin:0 0 6px; font-family:Arial, Helvetica, sans-serif; font-size:14px; line-height:20px; mso-line-height-rule:exactly; font-weight:bold; color:#EDF1F2;">${common.tagline}</p>
            <p style="margin:0; font-family:Arial, Helvetica, sans-serif; font-size:12px; line-height:18px; mso-line-height-rule:exactly; color:#A7B1B5;">${fillEmail(copy.footer, false)}</p>
          </td>
        </tr>
      </table>
      <!--[if mso]></td></tr></table><![endif]-->
    </td>
  </tr>
</table>
</body>
</html>
`;
}

const TEMPLATES = [
  ['email-verify', 'button'],
  ['password-reset', 'button'],
  ['email-confirm-change', 'button'],
  ['signin-passwordless', 'button'],
  ['signin-otp', 'code'],
];

const NBSP = ' ';

/**
 * Copy per locale. Only `en` is sent today (auth.user.locale.allowed in nhost.toml); the others are kept in
 * step so turning a locale on doesn't fall back to Nhost's defaults. Have a native speaker check them first.
 */
const COPY = {
  en: {
    common: {
      linkHelp: 'Button not working? Copy this link into your browser:',
      tagline: 'Every layover, someone to go with.',
    },
    'email-verify': {
      subject: 'Confirm your email for CrewUp',
      preheader: 'One tap to confirm your email and finish setting up your CrewUp account.',
      eyebrow: 'CONFIRM YOUR EMAIL',
      title: 'One tap and you’re in.',
      body: 'Confirm {email} to finish setting up your CrewUp account. Then it’s house rules, your profile, and your next layover.',
      cta: 'Verify email',
      fine: 'This link works once. If you didn’t sign up for CrewUp, you can ignore this email and no account will be created.',
      footer: 'Sent to {email} because it was used to sign up for CrewUp. This is an account email, so it can’t be unsubscribed from.',
    },
    'password-reset': {
      subject: 'Reset your CrewUp password',
      preheader: 'Use this link to set a new password for your CrewUp account.',
      eyebrow: 'PASSWORD RESET',
      title: 'Set a new password.',
      body: 'We got a request to reset the password for {email}. Tap below to choose a new one.',
      cta: 'Set new password',
      fine: 'Didn’t ask for this? Ignore this email. Your password stays the same and nobody can change it without this link.',
      footer: 'Sent to {email} because a password reset was requested. This is an account email, so it can’t be unsubscribed from.',
    },
    'email-confirm-change': {
      subject: 'Confirm your new email for CrewUp',
      preheader: 'Confirm this address to make it the new email on your CrewUp account.',
      eyebrow: 'EMAIL CHANGE',
      title: 'Confirm your new email.',
      body: 'Tap below to make this address the email for your CrewUp account. Until you do, we’ll keep using your current one.',
      cta: 'Confirm new email',
      fine: 'Didn’t request this? Ignore this email and nothing changes. If you think someone else has access to your account, reset your password in the app.',
      footer: 'Sent because an email change was requested on a CrewUp account. This is an account email, so it can’t be unsubscribed from.',
    },
    'signin-passwordless': {
      subject: 'Your CrewUp sign-in link',
      preheader: 'Tap the link to sign in to your CrewUp account.',
      eyebrow: 'SIGN IN',
      title: 'Your sign-in link.',
      body: 'Tap below to sign in to CrewUp as {email}.',
      cta: 'Sign in',
      fine: 'This link works once and expires soon. Didn’t ask for it? Ignore this email. Nobody can sign in without it.',
      footer: 'Sent to {email} because a sign-in link was requested. This is an account email, so it can’t be unsubscribed from.',
    },
    'signin-otp': {
      subject: 'Your CrewUp sign-in code',
      preheader: 'Use this code to sign in to CrewUp.',
      eyebrow: 'SIGN-IN CODE',
      title: 'Your sign-in code.',
      body: 'Enter this code in CrewUp to sign in as {email}.',
      fine: 'This code works once and expires soon. Didn’t ask for it? Ignore this email. Nobody can sign in without it.',
      footer: 'Sent to {email} because a sign-in code was requested. This is an account email, so it can’t be unsubscribed from.',
    },
  },
  es: {
    common: {
      linkHelp: '¿El botón no funciona? Copia este enlace en tu navegador:',
      tagline: 'En cada escala, alguien con quien salir.',
    },
    'email-verify': {
      subject: 'Confirma tu correo para CrewUp',
      preheader: 'Un toque para confirmar tu correo y terminar de configurar tu cuenta de CrewUp.',
      eyebrow: 'CONFIRMA TU CORREO',
      title: 'Un toque y listo.',
      body: 'Confirma {email} para terminar de configurar tu cuenta de CrewUp. Después vienen las normas de la casa, tu perfil y tu próxima escala.',
      cta: 'Verificar correo',
      fine: 'Este enlace solo funciona una vez. Si no te registraste en CrewUp, ignora este correo y no se creará ninguna cuenta.',
      footer: 'Enviado a {email} porque se usó para registrarse en CrewUp. Es un correo de la cuenta, así que no puedes darte de baja.',
    },
    'password-reset': {
      subject: 'Restablece tu contraseña de CrewUp',
      preheader: 'Usa este enlace para crear una nueva contraseña para tu cuenta de CrewUp.',
      eyebrow: 'RESTABLECER CONTRASEÑA',
      title: 'Crea una nueva contraseña.',
      body: 'Recibimos una solicitud para restablecer la contraseña de {email}. Toca abajo para elegir una nueva.',
      cta: 'Crear contraseña',
      fine: '¿No lo pediste? Ignora este correo. Tu contraseña sigue igual y nadie puede cambiarla sin este enlace.',
      footer: 'Enviado a {email} porque se pidió restablecer la contraseña. Es un correo de la cuenta, así que no puedes darte de baja.',
    },
    'email-confirm-change': {
      subject: 'Confirma tu nuevo correo para CrewUp',
      preheader: 'Confirma esta dirección para que sea el nuevo correo de tu cuenta de CrewUp.',
      eyebrow: 'CAMBIO DE CORREO',
      title: 'Confirma tu nuevo correo.',
      body: 'Toca abajo para que esta dirección sea el correo de tu cuenta de CrewUp. Hasta entonces, seguiremos usando el actual.',
      cta: 'Confirmar nuevo correo',
      fine: '¿No lo pediste? Ignora este correo y no cambiará nada. Si crees que alguien más tiene acceso a tu cuenta, restablece tu contraseña en la app.',
      footer: 'Enviado porque se pidió un cambio de correo en una cuenta de CrewUp. Es un correo de la cuenta, así que no puedes darte de baja.',
    },
    'signin-passwordless': {
      subject: 'Tu enlace para entrar en CrewUp',
      preheader: 'Toca el enlace para entrar en tu cuenta de CrewUp.',
      eyebrow: 'INICIAR SESIÓN',
      title: 'Tu enlace para entrar.',
      body: 'Toca abajo para entrar en CrewUp como {email}.',
      cta: 'Entrar',
      fine: 'Este enlace solo funciona una vez y caduca pronto. ¿No lo pediste? Ignora este correo: nadie puede entrar sin él.',
      footer: 'Enviado a {email} porque se pidió un enlace para iniciar sesión. Es un correo de la cuenta, así que no puedes darte de baja.',
    },
    'signin-otp': {
      subject: 'Tu código de acceso a CrewUp',
      preheader: 'Usa este código para entrar en CrewUp.',
      eyebrow: 'CÓDIGO DE ACCESO',
      title: 'Tu código para entrar.',
      body: 'Introduce este código en CrewUp para entrar como {email}.',
      fine: 'El código solo funciona una vez y caduca pronto. ¿No lo pediste? Ignora este correo: nadie puede entrar sin él.',
      footer: 'Enviado a {email} porque se pidió un código de acceso. Es un correo de la cuenta, así que no puedes darte de baja.',
    },
  },
  fr: {
    common: {
      linkHelp: `Le bouton ne fonctionne pas${NBSP}? Copiez ce lien dans votre navigateur${NBSP}:`,
      tagline: 'À chaque escale, quelqu’un avec qui sortir.',
    },
    'email-verify': {
      subject: 'Confirmez votre e-mail pour CrewUp',
      preheader: 'Un geste pour confirmer votre e-mail et finir de configurer votre compte CrewUp.',
      eyebrow: 'CONFIRMEZ VOTRE E-MAIL',
      title: 'Un geste et c’est parti.',
      body: `Confirmez {email} pour finir de configurer votre compte CrewUp. Ensuite${NBSP}: les règles de la maison, votre profil et votre prochaine escale.`,
      cta: 'Vérifier l’e-mail',
      fine: `Ce lien ne fonctionne qu’une fois. Si vous ne vous êtes pas inscrit sur CrewUp, ignorez cet e-mail${NBSP}: aucun compte ne sera créé.`,
      footer: 'Envoyé à {email} car cette adresse a servi à s’inscrire sur CrewUp. C’est un e-mail de compte, vous ne pouvez donc pas vous en désabonner.',
    },
    'password-reset': {
      subject: 'Réinitialisez votre mot de passe CrewUp',
      preheader: 'Utilisez ce lien pour définir un nouveau mot de passe pour votre compte CrewUp.',
      eyebrow: 'MOT DE PASSE',
      title: 'Choisissez un nouveau mot de passe.',
      body: 'Nous avons reçu une demande de réinitialisation du mot de passe de {email}. Touchez ci-dessous pour en choisir un nouveau.',
      cta: 'Nouveau mot de passe',
      fine: `Vous n’avez rien demandé${NBSP}? Ignorez cet e-mail. Votre mot de passe reste le même et personne ne peut le changer sans ce lien.`,
      footer: 'Envoyé à {email} car une réinitialisation du mot de passe a été demandée. C’est un e-mail de compte, vous ne pouvez donc pas vous en désabonner.',
    },
    'email-confirm-change': {
      subject: 'Confirmez votre nouvel e-mail pour CrewUp',
      preheader: 'Confirmez cette adresse pour en faire le nouvel e-mail de votre compte CrewUp.',
      eyebrow: 'CHANGEMENT D’E-MAIL',
      title: 'Confirmez votre nouvel e-mail.',
      body: 'Touchez ci-dessous pour faire de cette adresse l’e-mail de votre compte CrewUp. D’ici là, nous gardons l’actuelle.',
      cta: 'Confirmer le nouvel e-mail',
      fine: `Vous n’avez rien demandé${NBSP}? Ignorez cet e-mail, rien ne changera. Si vous pensez que quelqu’un d’autre a accès à votre compte, réinitialisez votre mot de passe dans l’app.`,
      footer: 'Envoyé car un changement d’e-mail a été demandé sur un compte CrewUp. C’est un e-mail de compte, vous ne pouvez donc pas vous en désabonner.',
    },
    'signin-passwordless': {
      subject: 'Votre lien de connexion CrewUp',
      preheader: 'Touchez le lien pour vous connecter à votre compte CrewUp.',
      eyebrow: 'CONNEXION',
      title: 'Votre lien de connexion.',
      body: 'Touchez ci-dessous pour vous connecter à CrewUp avec {email}.',
      cta: 'Se connecter',
      fine: `Ce lien ne fonctionne qu’une fois et expire bientôt. Vous n’avez rien demandé${NBSP}? Ignorez cet e-mail${NBSP}: personne ne peut se connecter sans lui.`,
      footer: 'Envoyé à {email} car un lien de connexion a été demandé. C’est un e-mail de compte, vous ne pouvez donc pas vous en désabonner.',
    },
    'signin-otp': {
      subject: 'Votre code de connexion CrewUp',
      preheader: 'Utilisez ce code pour vous connecter à CrewUp.',
      eyebrow: 'CODE DE CONNEXION',
      title: 'Votre code de connexion.',
      body: 'Saisissez ce code dans CrewUp pour vous connecter avec {email}.',
      fine: `Ce code ne fonctionne qu’une fois et expire bientôt. Vous n’avez rien demandé${NBSP}? Ignorez cet e-mail${NBSP}: personne ne peut se connecter sans lui.`,
      footer: 'Envoyé à {email} car un code de connexion a été demandé. C’est un e-mail de compte, vous ne pouvez donc pas vous en désabonner.',
    },
  },
  cs: {
    common: {
      linkHelp: 'Tlačítko nefunguje? Zkopírujte tento odkaz do prohlížeče:',
      tagline: 'Na každé zastávce někdo, s kým vyrazit.',
    },
    'email-verify': {
      subject: 'Potvrďte svůj e-mail pro CrewUp',
      preheader: 'Jedním klepnutím potvrdíte e-mail a dokončíte nastavení účtu CrewUp.',
      eyebrow: 'POTVRZENÍ E-MAILU',
      title: 'Jedno klepnutí a jste tam.',
      body: 'Potvrďte {email} a dokončete nastavení účtu CrewUp. Pak přijdou pravidla komunity, váš profil a vaše příští zastávka.',
      cta: 'Ověřit e-mail',
      fine: 'Odkaz funguje jen jednou. Pokud jste se do CrewUp neregistrovali, tento e-mail ignorujte a žádný účet nevznikne.',
      footer: 'Odesláno na {email}, protože byl použit k registraci do CrewUp. Jde o e-mail k účtu, proto se z něj nelze odhlásit.',
    },
    'password-reset': {
      subject: 'Obnovte si heslo k CrewUp',
      preheader: 'Tímto odkazem nastavíte nové heslo k účtu CrewUp.',
      eyebrow: 'OBNOVENÍ HESLA',
      title: 'Nastavte si nové heslo.',
      body: 'Obdrželi jsme žádost o obnovení hesla pro {email}. Klepnutím níže si zvolíte nové.',
      cta: 'Nastavit nové heslo',
      fine: 'Nežádali jste o to? Tento e-mail ignorujte. Heslo zůstane stejné a bez tohoto odkazu ho nikdo nezmění.',
      footer: 'Odesláno na {email}, protože bylo požádáno o obnovení hesla. Jde o e-mail k účtu, proto se z něj nelze odhlásit.',
    },
    'email-confirm-change': {
      subject: 'Potvrďte nový e-mail pro CrewUp',
      preheader: 'Potvrďte tuto adresu, aby se stala novým e-mailem vašeho účtu CrewUp.',
      eyebrow: 'ZMĚNA E-MAILU',
      title: 'Potvrďte nový e-mail.',
      body: 'Klepnutím níže nastavíte tuto adresu jako e-mail účtu CrewUp. Do té doby budeme používat tu současnou.',
      cta: 'Potvrdit nový e-mail',
      fine: 'Nežádali jste o to? Tento e-mail ignorujte a nic se nezmění. Pokud máte podezření, že k účtu má přístup někdo jiný, obnovte si heslo v aplikaci.',
      footer: 'Odesláno, protože byla u účtu CrewUp požadována změna e-mailu. Jde o e-mail k účtu, proto se z něj nelze odhlásit.',
    },
    'signin-passwordless': {
      subject: 'Váš odkaz pro přihlášení do CrewUp',
      preheader: 'Klepnutím na odkaz se přihlásíte k účtu CrewUp.',
      eyebrow: 'PŘIHLÁŠENÍ',
      title: 'Váš odkaz pro přihlášení.',
      body: 'Klepnutím níže se přihlásíte do CrewUp jako {email}.',
      cta: 'Přihlásit se',
      fine: 'Odkaz funguje jen jednou a brzy vyprší. Nežádali jste o něj? Tento e-mail ignorujte, bez něj se nikdo nepřihlásí.',
      footer: 'Odesláno na {email}, protože byl vyžádán odkaz pro přihlášení. Jde o e-mail k účtu, proto se z něj nelze odhlásit.',
    },
    'signin-otp': {
      subject: 'Váš přihlašovací kód do CrewUp',
      preheader: 'Tímto kódem se přihlásíte do CrewUp.',
      eyebrow: 'PŘIHLAŠOVACÍ KÓD',
      title: 'Váš přihlašovací kód.',
      body: 'Zadejte tento kód v CrewUp a přihlaste se jako {email}.',
      fine: 'Kód funguje jen jednou a brzy vyprší. Nežádali jste o něj? Tento e-mail ignorujte, bez něj se nikdo nepřihlásí.',
      footer: 'Odesláno na {email}, protože byl vyžádán přihlašovací kód. Jde o e-mail k účtu, proto se z něj nelze odhlásit.',
    },
  },
  bg: {
    common: {
      linkHelp: 'Бутонът не работи? Копирайте този линк в браузъра си:',
      tagline: 'На всеки престой – някой, с когото да излезеш.',
    },
    'email-verify': {
      subject: 'Потвърдете имейла си за CrewUp',
      preheader: 'Едно докосване, за да потвърдите имейла си и да завършите акаунта си в CrewUp.',
      eyebrow: 'ПОТВЪРДЕТЕ ИМЕЙЛА',
      title: 'Едно докосване и сте вътре.',
      body: 'Потвърдете {email}, за да завършите настройката на акаунта си в CrewUp. След това идват правилата, профилът ви и следващият ви престой.',
      cta: 'Потвърди имейла',
      fine: 'Линкът работи само веднъж. Ако не сте се регистрирали в CrewUp, игнорирайте този имейл и няма да бъде създаден акаунт.',
      footer: 'Изпратено до {email}, защото е използван за регистрация в CrewUp. Това е имейл за акаунта, затова не можете да се отпишете от него.',
    },
    'password-reset': {
      subject: 'Нулирайте паролата си за CrewUp',
      preheader: 'Използвайте този линк, за да зададете нова парола за акаунта си в CrewUp.',
      eyebrow: 'НУЛИРАНЕ НА ПАРОЛА',
      title: 'Задайте нова парола.',
      body: 'Получихме заявка за нулиране на паролата за {email}. Докоснете по-долу, за да изберете нова.',
      cta: 'Задай нова парола',
      fine: 'Не сте поискали това? Игнорирайте този имейл. Паролата ви остава същата и никой не може да я смени без този линк.',
      footer: 'Изпратено до {email}, защото е поискано нулиране на паролата. Това е имейл за акаунта, затова не можете да се отпишете от него.',
    },
    'email-confirm-change': {
      subject: 'Потвърдете новия си имейл за CrewUp',
      preheader: 'Потвърдете този адрес, за да стане новият имейл на акаунта ви в CrewUp.',
      eyebrow: 'СМЯНА НА ИМЕЙЛ',
      title: 'Потвърдете новия си имейл.',
      body: 'Докоснете по-долу, за да направите този адрес имейл на акаунта си в CrewUp. Дотогава ще използваме сегашния.',
      cta: 'Потвърди новия имейл',
      fine: 'Не сте поискали това? Игнорирайте този имейл и нищо няма да се промени. Ако смятате, че някой друг има достъп до акаунта ви, нулирайте паролата си в приложението.',
      footer: 'Изпратено, защото е поискана смяна на имейла за акаунт в CrewUp. Това е имейл за акаунта, затова не можете да се отпишете от него.',
    },
    'signin-passwordless': {
      subject: 'Вашият линк за вход в CrewUp',
      preheader: 'Докоснете линка, за да влезете в акаунта си в CrewUp.',
      eyebrow: 'ВХОД',
      title: 'Вашият линк за вход.',
      body: 'Докоснете по-долу, за да влезете в CrewUp като {email}.',
      cta: 'Вход',
      fine: 'Линкът работи само веднъж и скоро изтича. Не сте го поискали? Игнорирайте този имейл – никой не може да влезе без него.',
      footer: 'Изпратено до {email}, защото е поискан линк за вход. Това е имейл за акаунта, затова не можете да се отпишете от него.',
    },
    'signin-otp': {
      subject: 'Вашият код за вход в CrewUp',
      preheader: 'Използвайте този код, за да влезете в CrewUp.',
      eyebrow: 'КОД ЗА ВХОД',
      title: 'Вашият код за вход.',
      body: 'Въведете този код в CrewUp, за да влезете като {email}.',
      fine: 'Кодът работи само веднъж и скоро изтича. Не сте го поискали? Игнорирайте този имейл – никой не може да влезе без него.',
      footer: 'Изпратено до {email}, защото е поискан код за вход. Това е имейл за акаунта, затова не можете да се отпишете от него.',
    },
  },
};

const check = process.argv.includes('--check');
const stale = [];

for (const [lang, copy] of Object.entries(COPY)) {
  for (const [name, kind] of TEMPLATES) {
    const dir = join(ROOT, lang, name);
    const files = {
      'body.html': render(lang, copy.common, copy[name], kind),
      'subject.txt': copy[name].subject,
    };
    for (const [file, content] of Object.entries(files)) {
      const path = join(dir, file);
      const current = existsSync(path) ? readFileSync(path, 'utf8') : null;
      if (current === content) continue;
      if (check) {
        stale.push(`${lang}/${name}/${file}`);
        continue;
      }
      mkdirSync(dir, { recursive: true });
      writeFileSync(path, content);
      console.log(`wrote ${lang}/${name}/${file}`);
    }
  }
}

if (check && stale.length) {
  console.error(`Out of date — run node scripts/build-emails.mjs:\n  ${stale.join('\n  ')}`);
  process.exit(1);
}
