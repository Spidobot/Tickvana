# Single sign-on with Microsoft Entra ID (Microsoft 365)

The apps sign in through OpenID Connect. Tickvana and Nuvenna share one
configuration and one session; you register **one** application in Entra ID
with **two** redirect addresses.

## 1. Register the application

In the [Entra admin center](https://entra.microsoft.com): *Identity →
Applications → App registrations → New registration*.

- **Name:** Tickvana and Nuvenna
- **Supported account types:** *Accounts in this organizational directory
  only* (single tenant).
- **Redirect URI:** platform *Web*,
  `https://work.example.org/tickvana/api/core/auth/oidc/callback`

After creating it, under *Authentication* add the second redirect URI:

```text
https://work.example.org/nuvenna/api/core/auth/oidc/callback
```

Replace `https://work.example.org` with your `BASE_URL`.

## 2. Secret and IDs

- *Certificates & secrets → New client secret*. Copy the **value** (not the
  secret ID); it is shown only once. Note its expiry date: sign-in stops
  when it runs out.
- *Overview*: copy the **Application (client) ID** and the **Directory
  (tenant) ID**.

## 3. Claims

Under *Token configuration*:

- *Add optional claim → ID → `email`* and `preferred_username` (allow the
  Microsoft Graph permission when asked).
- For groups, see step 5.

Entra ID often sends neither a verified `email` claim nor `email_verified`.
That is why there is the switch **Trust the provider's e-mail addresses**: with it, the address from `email`, or else from
`preferred_username`, counts as verified, and an existing account
with that address is linked on first sign-in. Only turn it on for your own
single-tenant registration, where your organisation controls every address.

## 4. Configure the apps

*Administration → System → Sign-in* (German: *Anmeldung*):

| Field | Value |
| --- | --- |
| Sign in through a provider | on |
| Issuer address | `https://login.microsoftonline.com/<tenant ID>/v2.0` |
| Client ID | Application (client) ID |
| Client secret | the secret value |
| Scopes | `openid email profile` |
| Text on the sign-in button | e.g. *Sign in with Microsoft* |
| Create accounts on first sign-in | on: anyone in your tenant who signs in gets an account; off: only existing addresses get in |
| Trust the provider's e-mail addresses | on (see step 3) |
| Send visitors straight to the provider | on to skip the sign-in form; `…/tickvana/?local=1` still shows it for the local administrator |
| Claim with group names | see step 5, or empty |

Save, sign out, and try it in a private window before turning on the
redirect.

## 5. Groups from Entra ID (optional)

When **Claim with group names** names a claim, Entra ID owns group membership: on
every sign-in the user's groups are replaced by the names in that
claim, and groups that do not exist yet are created. Grant rights in
Tickvana and Nuvenna (project roles, space permissions, global rights) to those groups.

The apps compare **names**. Entra ID sends group *object IDs* by default,
which would make groups named like `3f2a…`. Two ways to get readable names:

- **App roles (recommended).** *App roles → Create app role* (e.g.
  `Support`, `Developers`, allowed member type *Users/Groups*), then in
  *Enterprise applications → Tickvana and Nuvenna → Users and groups* assign your Entra
  groups to those roles. Set *Claim with group names* to `roles`.
- **Group names.** *Token configuration → Add groups claim*, choose
  *Groups assigned to the application*, and for the ID token pick *Emit
  groups as role claims* off and *sAMAccountName* (synchronised groups) or
  *Cloud-only group display names*. Set *Claim with group names* to `groups`.

Users in more than 200 groups get no groups claim from Entra ID at all
("overage"); assigning only the groups that matter to the application, or
app roles, avoids that.

## Troubleshooting

- *"The identity provider sent no e-mail address"*: add the optional claims
  from step 3, or turn on *Trust the provider's e-mail addresses*.
- *"An account with this e-mail exists, but the provider has not verified
  the address"*: turn on *Trust the provider's e-mail addresses* for your own tenant.
- *"No account exists for this e-mail address"*: *Create accounts on first sign-in* is off
  and the person has no account yet; invite them first.
- Redirect mismatch (`AADSTS50011`): both callback addresses from step 1
  must be registered exactly, including `https` and no trailing slash.
