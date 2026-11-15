# Tickvana und Nuvenna — Konzept

Freie Ticketverwaltung (Tickvana) und freies Wiki (Nuvenna) für Teams. Selbst gehostet, per Docker, mit externer Datenbank.

- **Tickvana** — Issue-Tracker, Boards, Service-Desk mit Self-Service-Portal
- **Nuvenna** — Wiki mit gleichzeitigem Bearbeiten derselben Seite

Namen geprüft am 2026-11-15: „Tickvana“ und „Nuvenna“ frei auf GitHub und npm, keine Web-Treffer für gleichnamige Software oder Firmen, .com/.org/.de ohne DNS-Eintrag. Nicht geprüft: Markenregister (DPMA, EUIPO). Vor Veröffentlichung nachholen. Interne Kurzform für Pakete und Container: `tvn`. Tabellenpräfixe `track_`/`pages_` bleiben (Migrationen werden nie geändert).

Lizenz: AGPL-3.0 (verhindert, dass jemand das Projekt geschlossen als SaaS weiterverkauft). Wer lieber permissiv will, tauscht auf Apache-2.0, bevor der erste fremde Beitrag kommt.

---

## 1. Leitentscheidungen

| Thema | Entscheidung | Grund |
| --- | --- | --- |
| Sprache | TypeScript überall, Node 22 | Ein Typsystem von DB bis UI, Zod-Schemas werden geteilt |
| Repo | pnpm-Monorepo | Zwei Apps, gemeinsamer Kern |
| Server | Fastify + Zod, OpenAPI wird generiert | Wenig Rahmenwerk, REST-API fällt als Nebenprodukt ab |
| Datenbank | Kysely (Query-Builder + Migrator) | Dialekt per Konfiguration, kein Hersteller-SQL im Code |
| Web | React, Vite, TanStack Query/Router, Radix-Primitives, Tailwind | Verbreitet, zugänglich, Modelle kennen es gut |
| Editor | Tiptap (ProseMirror) | In Tickvana für Beschreibung/Kommentar, in Nuvenna für Seiten |
| Echtzeit | Yjs + Hocuspocus | Standard für CRDT-Kollaboration, kein Eigenbau |
| Jobs | Tabelle `core_job`, Worker im selben Prozess | Kein Redis, kein Broker |
| Suche | normalisierte Textspalten + `LIKE` | Portabel. Meilisearch-Adapter erst, wenn es messbar zu langsam ist |
| Dateien | Dateisystem-Volume | S3-Adapter später |
| Anmeldung | lokal (argon2) + OIDC | OIDC deckt Keycloak, Entra, Google ab. LDAP später |
| i18n | i18next, Deutsch und Englisch ab Tag 1 | Nachträglich teuer |

### Datenbank „muss egal sein“

Erreicht wird das über drei Regeln, nicht über eine Abstraktionsschicht:

1. Jeder Zugriff läuft über Kysely. Kein rohes SQL im Anwendungscode.
2. Keine Herstellerfunktionen: kein JSONB-Operator, kein RLS, kein `SKIP LOCKED`, keine Arrays, kein Volltextindex.
3. Die wenigen unvermeidbaren Unterschiede (String-Aggregation, Groß-/Kleinschreibung bei `LIKE`, Statement-Timeout) liegen in **einer** Datei `packages/core/src/db/dialect.ts`.

Getestet in CI: **PostgreSQL 16+** (Referenz) und **MariaDB 11+**. MSSQL und andere sind danach ein Kysely-Dialekt plus ein Eintrag in `dialect.ts`, werden aber erst gebaut, wenn jemand sie braucht. SQLite bleibt bewusst draußen (anderes Typsystem, zusätzliche Testmatrix, kein Nutzen im Betrieb).

IDs sind UUIDv7 als Text, in der Anwendung erzeugt. Zeitstempel UTC im nativen Typ.

---

## 2. Architektur

```
                 ┌──────────────── Caddy (TLS, ein Origin) ───────────────┐
Browser ───────► │  /track/*  ──► track:3000     /pages/*  ──► pages:3000 │
                 └────────────────────────────────────────────────────────┘
                        │                               │
                  API + Web + Worker            API + Web + Worker
                                                + Hocuspocus (WebSocket)
                        │                               │
                        └──────────┬────────────────────┘
                                   ▼
                     externe DB (gemeinsam)      Volume /data (Anhänge)
```

Zwei Container, ein Origin, eine Datenbank.

- **Jede App läuft allein.** Nuvenna ohne Tickvana funktioniert, Issue-Links werden dann als normaler Text dargestellt.
- **Gemeinsamer Kern** `packages/core` steckt in beiden Images: Benutzer, Gruppen, Sitzungen, Branding, Anhänge, Ereignisse, Jobs, Abfrage-Engine. Die `core_*`-Tabellen gehören beiden. Wer zuerst startet, migriert (Kysely-Migrator sperrt selbst).
- **Ein Login.** Sitzungs-Cookie mit Pfad `/`, Sitzungen liegen in `core_session`. Beide Apps lesen dieselbe Tabelle. Kein SSO-Tanz zwischen den Containern.
- **Kommunikation zwischen den Apps** läuft im Browser: Nuvenna ruft `/track/api/...` mit dem Cookie des Benutzers auf. Tickvana prüft die Rechte selbst. Kein Dienstkonto, kein internes Token, keine Rechteumgehung möglich.
- **Rückverweise** stehen in `core_link` (gemeinsame Tabelle). Titel der Gegenseite werden nie gespeichert, sondern beim Anzeigen über die API der anderen App geholt. So sieht niemand Titel von Seiten oder Tickets, die er nicht sehen darf.

### Routen je App

```
/track/                 Web-Oberfläche
/track/portal/          Self-Service-Portal (eigenes, schlankes Layout)
/track/admin/           Administration
/track/api/             REST (OpenAPI unter /track/api/docs)
/track/api/core/        Kern-Routen (Login, Benutzer, Branding …)
/pages/ …               analog, zusätzlich /pages/collab (WebSocket)
```

### Repo

```
packages/core    DB, Migrationen, Auth, Rechte, Ereignisse, Jobs, Mail, Anhänge, Abfrage-Engine
packages/ui      Design-Tokens, Komponenten, App-Rahmen, Editor, Kern-Adminseiten
apps/tickvana       server/ + web/
apps/nuvenna       server/ + web/
docker/          Dockerfiles, compose.yml, Caddyfile, DB-Init für Leserolle
```

### Ein Mechanismus für alles Nachgelagerte

Jede Änderung schreibt in derselben Transaktion eine Zeile nach `core_event`. Der Worker liest neue Ereignisse und verteilt sie an: Benachrichtigungen, Mail, Webhooks, Automationsregeln, SLA-Uhren, Suchtext. `core_event` ist gleichzeitig Audit-Log und Aktivitäts-Feed. Es gibt keinen zweiten Weg, nachgelagerte Logik anzustoßen.

Jobs werden portabel beansprucht: `UPDATE core_job SET locked_by = ? WHERE id = ? AND locked_by IS NULL`, betroffene Zeilen prüfen.

---

## 3. Abfrage-Engine (SQL statt JQL)

Das Kernmerkmal. Es gibt **keine** eigene Abfragesprache. Filter, Boards, Queues, Dashboards, Berichte und Wiki-Makros sind gespeicherte SQL-`SELECT`s. Der grafische Filterbaukasten erzeugt SQL, der Experte schreibt es direkt.

### Virtuelle Tabellen (öffentlicher Vertrag, versioniert)

`issues`, `issue_history`, `comments`, `worklogs`, `issue_links`, `issue_labels`, `issue_components`, `issue_versions`, `projects`, `users`, `groups`, `sprints`, `versions`, `components`, `sla_cycles`, `spaces`, `pages`, `page_versions`, `links`

`issues` enthält jedes benutzerdefinierte Feld als Spalte `cf_<schlüssel>`. Mehrfachwerte kommen als kommagetrennter Text und zusätzlich zeilenweise in `issue_field_values`.

Diese Tabellen existieren nicht in der Datenbank. Die Engine erzeugt sie je Abfrage als CTE.

### Ablauf

1. **Parsen** mit `node-sql-parser` im Dialekt der konfigurierten DB.
2. **Prüfen** am Syntaxbaum:
   - genau eine Anweisung, nur `SELECT` (inklusive `WITH`, `UNION`, Unterabfragen, Fensterfunktionen)
   - jede Tabellenreferenz ist unqualifiziert und steht auf der Liste der virtuellen Tabellen oder ist eine CTE des Benutzers
   - CTE-Namen des Benutzers dürfen keine virtuelle Tabelle überdecken
   - Funktionen nur von einer Positivliste (Aggregate, Datum, Text, Mathematik). Alles andere wird abgelehnt
3. **Umschreiben:** vor die Abfrage kommen CTEs mit den Namen der virtuellen Tabellen. Jede filtert auf das, was der Benutzer sehen darf (Projektliste aus der Rechteprüfung, Sicherheitsstufen, Seitenbeschränkungen). Abhängige Tabellen filtern über `issue_id IN (SELECT id FROM issues)`. Es werden nur die `cf_`-Spalten gebaut, die die Abfrage verwendet (bei `SELECT *` alle).
4. **Ausführen** über eine zweite Verbindung `DB_QUERY_URL` mit einer DB-Rolle, die nur `SELECT` auf die nötigen Basistabellen hat. Tabellen mit Geheimnissen (`core_session`, `core_api_token`, Passwort-Hashes) sind für diese Rolle nicht lesbar. Dazu Statement-Timeout und Zeilenlimit (äußere Abfrage mit `LIMIT`).
5. **Parameter:** `:current_user`, `:now`, `:project` und frei definierte, immer gebunden, nie eingesetzt.

Fehlt `DB_QUERY_URL`, dürfen nur Systemadministratoren freies SQL schreiben, und die Adminseite warnt. Das mitgelieferte Compose legt die Leserolle automatisch an.

Zwei Sicherungslinien also: Syntaxbaum-Prüfung und DB-Rolle. Fällt eine, hält die andere.

### Was darauf aufbaut

| Funktion | Umsetzung |
| --- | --- |
| Gespeicherter Filter | `core_saved_query` mit Sichtbarkeit privat, Gruppe, alle |
| Board, Backlog, Queue | zeigen auf eine gespeicherte Abfrage, die `id` liefert |
| Dashboard-Widget | Abfrage + Darstellung (Tabelle, Zahl, Balken, Linie, Torte) |
| Abo | Abfrage + Zeitplan, Ergebnis per Mail |
| Wiki-Makro „Abfrage“ | Abfrage-ID oder SQL, Darstellung wie Widget |
| Automationsbedingung | „Ticket erfüllt Abfrage X“ |
| Export | jedes Ergebnis als CSV und JSON |

Gespeicherte Abfragen sind an den Dialekt gebunden. Ein Wechsel der Datenbank kann einzelne Abfragen brechen. Das ist der Preis dafür, dass echtes SQL erlaubt ist.

---

## 4. Datenmodell

Nur die tragenden Tabellen. Zeitstempel und `created_by` sind überall dabei und hier weggelassen.

### Kern (`core_*`)

```
core_user(id, email, display_name, password_hash?, kind: internal|customer|service, active, locale, timezone)
core_identity(user_id, provider, subject)                  -- OIDC
core_group(id, name)   core_group_member(group_id, user_id)
core_session(id_hash, user_id, expires_at)
core_api_token(id, token_hash, user_id, name, expires_at)
core_setting(key, value_json)                              -- Branding, Mail, Auth, Systemwerte
core_attachment(id, owner_type, owner_id, filename, mime, size, storage_key)
core_event(id, type, actor_id, entity_type, entity_id, payload_json, created_at)
core_job(id, type, payload_json, run_at, state, attempts, locked_by, locked_at, last_error)
core_notification(id, user_id, event_id, read_at)
core_webhook(id, url, secret, event_filter_json, active)
core_saved_query(id, owner_id, name, sql, params_json, visibility, group_id?)
core_dashboard(id, owner_id, name, visibility, layout_json)
core_dashboard_widget(id, dashboard_id, query_id, kind, config_json)
core_link(from_type, from_id, to_type, to_id, kind)        -- Seite↔Ticket, Ticket↔Ticket app-übergreifend
```

### Tickvana

```
project(id, key, name, kind: software|service|business, lead_id, permission_scheme_id,
        notification_scheme_id, issue_counter, archived)
issue_type(id, name, icon, level)                          -- -1 Unteraufgabe, 0 Standard, 1 Epic, 2+ frei
project_issue_type(project_id, issue_type_id, workflow_id, field_layout_id)

status(id, name, category: todo|in_progress|done)
workflow(id, name)
workflow_status(workflow_id, status_id, x, y)
workflow_transition(id, workflow_id, from_status_id?, to_status_id, name, field_layout_id?, rules_json)

field(id, key, name, type, is_system, config_json)
field_option(id, field_id, parent_id?, value, position, disabled)
field_layout(id, name)
field_layout_item(layout_id, operation: create|edit|view|transition|portal, field_id,
                  position, tab, required, hidden)

issue(id, project_id, number, key, type_id, status_id, summary, description_json, description_text,
      priority_id, resolution_id?, reporter_id, assignee_id?, parent_id?, security_level_id?,
      rank, due_date?, estimate_sec?, remaining_sec?, spent_sec, resolved_at?)
issue_field_value(issue_id, field_id, position, value_text?, value_number?, value_date?, value_ref?)
issue_change(id, issue_id, actor_id)   issue_change_item(change_id, field_key, from_value, from_text, to_value, to_text)
comment(id, issue_id, author_id, body_json, body_text, visibility: public|internal)
worklog(id, issue_id, author_id, started_at, seconds, note)
watcher(issue_id, user_id)   vote(issue_id, user_id)   issue_label(issue_id, label)
component(id, project_id, name, lead_id?)   issue_component(issue_id, component_id)
version(id, project_id, name, start_date?, release_date?, released)   issue_version(issue_id, version_id, kind: fix|affects)
link_type(id, name, outward, inward)   issue_link(id, type_id, from_issue_id, to_issue_id)
sprint(id, board_id, name, goal, start_at?, end_at?, state)   sprint_issue(sprint_id, issue_id, added_at, removed_at?)
board(id, name, kind: scrum|kanban, query_id, columns_json, swimlane_json, estimate_field_id?)
priority(id, name, position, color)   resolution(id, name)

project_role(id, name)   project_role_member(project_id, role_id, principal_type, principal_id)
permission_scheme(id, name)
permission_grant(scheme_id, permission, grantee_type: role|group|user|anyone|logged_in|reporter|assignee|customer, grantee_id?)
security_level(id, project_id, name)   security_level_member(level_id, grantee_type, grantee_id?)
notification_scheme(id, name)   notification_rule(scheme_id, event_type, recipient_type, recipient_id?)

automation_rule(id, project_id?, name, trigger_json, conditions_json, actions_json, actor_id, enabled)
automation_run(id, rule_id, event_id, state, log_json)

-- Service-Desk
request_type(id, project_id, issue_type_id, name, description, icon, group_name, field_layout_id, position)
organization(id, name)   organization_member(organization_id, user_id)
project_customer(project_id, principal_type: user|organization, principal_id)
queue(id, project_id, name, query_id, position)
calendar(id, name, timezone, hours_json, holidays_json)
sla_policy(id, project_id, name, calendar_id, start_json, pause_json, stop_json, goals_json)
sla_cycle(id, issue_id, policy_id, started_at, paused_ms, due_at, stopped_at?, breached)
approval(id, issue_id, approver_id, decision?, decided_at?)
canned_response(id, project_id?, name, body_json)
mail_channel(id, project_id, request_type_id, imap_json, active)
```

Bewusste Vereinfachung: keine Schema-Zwischenschicht für Workflows und Masken. Ein Projekt ordnet je Issue-Typ direkt einen Workflow und ein Feldlayout zu. Workflows und Layouts sind benannt und zwischen Projekten wiederverwendbar. Das spart drei Tabellenebenen und eine schwer verständliche Verwaltungsseite.

**Benutzerdefinierte Felder** liegen als typisierte Zeilen in `issue_field_value`. Mehrfachwerte sind mehrere Zeilen. Das ist portabel, sortierbar, indexierbar und lässt sich in der Abfrage-Engine zu Spalten drehen.

Feldtypen: Text, Mehrzeilentext, Rich-Text, Zahl, Datum, Datum+Zeit, Auswahl, Mehrfachauswahl, kaskadierende Auswahl, Checkbox, Benutzer, mehrere Benutzer, Gruppe, Labels, URL, Ticketverweis. Systemfelder (Zusammenfassung, Status, Bearbeiter …) sind Zeilen in `field` mit `is_system`, damit Layouts und Abfragen sie gleich behandeln.

**Workflow-Regeln** (`rules_json`) verweisen auf eingebaute, registrierte Funktionen mit Parametern. Bedingungen (wer darf), Validatoren (was muss gefüllt sein), Nachfunktionen (Feld setzen, zuweisen, Ereignis feuern). Keine Skripte von Benutzern.

**Rang** ist eine LexoRank-Zeichenkette, damit Umsortieren im Backlog eine Zeile ändert.

### Nuvenna

```
space(id, key, name, description, home_page_id?, archived)
space_permission(space_id, permission, grantee_type: group|user|anyone|logged_in, grantee_id?)
page(id, space_id, parent_id?, position, title, kind: page|blog|template, status: current|trashed,
     version, content_json, content_text, updated_by)
page_ydoc(page_id, state)                                  -- Binärspalte
page_version(page_id, number, title, content_json, author_id, message?)
page_restriction(page_id, kind: view|edit, grantee_type, grantee_id)
page_comment(id, page_id, parent_id?, anchor_json?, body_json, resolved)
page_label(page_id, label)   page_watch(page_id, user_id)   page_favorite(page_id, user_id)   page_like(page_id, user_id)
public_share(id, page_id, token_hash, expires_at?)
```

---

## 5. Rechte

Eine Funktion entscheidet alles: `can(user, permission, target)`. Daneben `visibleProjectIds(user)` und `visibleSpaceIds(user)` für Listen und die Abfrage-Engine. Kein Handler prüft Rechte auf eigene Faust.

- **Global:** Systemadmin, Benutzer anlegen, Projekte anlegen, Spaces anlegen, freies SQL.
- **Tickvana:** Rechteschema je Projekt. Rechte wie Ansehen, Anlegen, Bearbeiten, Zuweisen, Übergang ausführen, Kommentieren, interne Kommentare sehen, Anhänge, Zeiterfassung, Löschen, Projekt verwalten. Vergeben an Rolle, Gruppe, Benutzer, Melder, Bearbeiter, Kunde, alle Angemeldeten, alle.
- **Sicherheitsstufen** schränken einzelne Tickets zusätzlich ein.
- **Kunden** (`kind = customer`) sehen nur das Portal, nur eigene Tickets und die ihrer Organisation, nur öffentliche Kommentare und nur Felder aus dem Portal-Layout.
- **Nuvenna:** Rechte je Space (Ansehen, Bearbeiten, Löschen, Kommentieren, Verwalten). Seitenbeschränkungen: Ansicht vererbt sich nach unten, Bearbeiten gilt nur für die Seite.

Anonymer Zugriff ist der Empfänger `anyone` und standardmäßig aus.

---

## 6. Gleichzeitiges Bearbeiten (Nuvenna)

- Tiptap mit Yjs-Kollaboration und sichtbaren Cursorn.
- Hocuspocus läuft im Nuvenna-Prozess unter `/pages/collab`.
- `onAuthenticate`: Sitzungs-Cookie prüfen, dann `can(user, 'page.edit', page)`. Nur-Lese-Rechte verbinden schreibgeschützt.
- `onStoreDocument` (entprellt): schreibt `page_ydoc.state` und leitet daraus `content_json` und `content_text` ab. Lesende Zugriffe, Suche, Export und die Abfrage-Engine brauchen nie Yjs.
- **Kein Entwurf/Veröffentlichen.** Die Seite ist live und speichert sich selbst. Eine Version entsteht automatisch, wenn eine Bearbeitungssitzung endet (letzter Bearbeiter getrennt oder 10 Minuten Ruhe), und auf Knopfdruck mit Kommentar. Wiederherstellen einer Version ersetzt den Dokumentinhalt als normale Änderung.
- Grenze: ein Nuvenna-Container. Mehrere Instanzen brauchen die Redis-Erweiterung von Hocuspocus. Erst bauen, wenn eine Instanz nicht mehr reicht.

Der Tiptap-Editor liegt in `packages/ui` und wird in Tickvana (ohne Yjs) für Beschreibungen und Kommentare wiederverwendet. Ein Dokumentformat für beide Apps.

### Blöcke im Editor

Überschriften, Listen, Aufgabenlisten, Tabellen, Code mit Hervorhebung, Zitat, Hinweisboxen, Ausklappbereich, Bild, Anhang, Erwähnung, Datum, Status-Marke, Inhaltsverzeichnis, Unterseitenliste, Seiteneinbindung, **Ticket** (Schlüssel, Titel, Status live aus Tickvana), **Abfrage** (Tabelle oder Diagramm aus der Abfrage-Engine).

---

## 7. Anpassbarkeit

Alles über die Adminoberfläche, nichts über Konfigurationsdateien außer den Startvariablen.

- **Branding** (`core_setting`): Produktname, Logo hell/dunkel, Favicon, Akzentfarbe, Anmeldetext, Fußzeile, Mail-Vorlagen, Portal-Titel und -Banner, optional eigenes CSS. Ausgeliefert als `/…/api/core/branding.css` mit CSS-Variablen. Beim Speichern prüft der Server den Kontrast der Akzentfarbe (4,5 : 1) und leitet bei Bedarf eine dunklere Textvariante ab.
- **Tickvana:** Issue-Typen, Felder, Optionen, Layouts je Vorgang, Workflows (grafischer Editor), Status, Prioritäten, Lösungen, Verknüpfungstypen, Rollen, Rechteschemata, Benachrichtigungsschemata, Sicherheitsstufen, Automationsregeln, Projektvorlagen.
- **Service-Desk:** Anfragetypen mit eigenem Formular, Portalgruppen, Queues, SLAs, Kalender, Genehmigungen, Textbausteine, Mail-Kanäle, Kundenzugang (offen oder nur eingeladen).
- **Nuvenna:** Space-Rechte, Vorlagen, Startseite, Seitenbaum.
- **System:** Benutzer, Gruppen, OIDC, SMTP, Webhooks, API-Token, Audit-Log, Jobstatus.

---

## 8. Oberfläche

Gestaltungsrichtung nach dem Unslop-Verfahren (Damir Sokolovsky, CC BY 4.0). Gilt als Vorschlag, bis sie bestätigt ist.

- **Produkt:** Werkzeug, mit dem Teams Arbeit verfolgen und Wissen aufschreiben, auf eigener Infrastruktur.
- **Charakter:** sachlich, dicht, handwerklich.
- **Welt:** Werkstatt und Laufzettel. Stempel, Karteikarte, technische Zeichnung.
- **Momente:** das Board (Karten mit echter Dichte und Gewicht) und die Seite mit lebenden Cursorn.
- **Signatur:** der Ticketschlüssel als kleine Mono-Marke, überall gleich gesetzt, in Tickvana, im Portal und im Wiki.

Feste Regeln für alle UI-Aufgaben:

- 4-px-Raster. Navigationszeilen 32 bis 36 px, Seitenleiste 240 bis 280 px, Inhalt fließend bis 1600 px.
- Eine neutrale Grafit-Rampe für Flächen, Linien und Text, hell und dunkel. Drei Textrollen. Ein Akzent, und der kommt aus dem Branding.
- Inter für die Oberfläche, Geist Mono für Schlüssel, Zahlen, Zeiten. Gewichte 400 und 500. Normale Groß-/Kleinschreibung, keine gesperrten Versalien.
- lucide-Icons, 16 px, Strich 1,5, in Textfarbe. Keine Emojis in der Oberfläche.
- Keine Farbverläufe, kein Leuchten, keine farbigen Schatten. Tiefe durch Flächenstufen und Haarlinien.
- Statuskategorien sind die einzige feste Farbbedeutung (offen neutral, in Arbeit Akzent, erledigt grün), gedämpft.
- Bewegung nur als Rückmeldung: 120 bis 180 ms, eine Kurve, nur Farbe, Deckkraft, Transform.
- Texte kurz, ohne Ausrufezeichen, ohne Begrüßungsüberschrift.
- Tastatur zuerst: Befehlspalette, sichtbarer Fokus, Kürzel als Tastenkappen.

Das Portal hat ein eigenes, ruhigeres Layout ohne Seitenleiste: Suche, Anfragetypen in Gruppen, „Meine Anfragen“.

---

## 9. Betrieb

```yaml
# docker/compose.yml (Auszug)
services:
  caddy:  { image: caddy:2, ports: ["80:80", "443:443"] }
  tickvana: { image: ghcr.io/spidobot/tickvana, env_file: .env, volumes: ["data:/data"] }
  nuvenna:  { image: ghcr.io/spidobot/nuvenna, env_file: .env, volumes: ["data:/data"] }
  db:     { image: postgres:16, profiles: ["with-db"] }   # nur wenn keine externe DB
```

| Variable | Zweck |
| --- | --- |
| `DB_URL` | `postgres://…` oder `mysql://…`. Das Schema entscheidet den Dialekt |
| `DB_QUERY_URL` | Verbindung der Leserolle für die Abfrage-Engine |
| `SECRET_KEY` | signiert Cookies, verschlüsselt gespeicherte Zugangsdaten (IMAP, SMTP, Webhook-Geheimnisse) |
| `BASE_URL` | öffentliche Adresse |
| `STORAGE_PATH` | Anhänge, Standard `/data` |
| `ROLE` | `all` (Standard), `web` oder `worker` |

SMTP und OIDC werden in der Adminoberfläche gepflegt. Der erste Start zeigt einen Einrichtungsassistenten (Admin anlegen, Name, Akzentfarbe).

Sicherung: Datenbank-Dump und das Volume. Mehr Zustand gibt es nicht.

---

## 10. Sicherheit

- Jede Eingabe an der API-Grenze durch Zod.
- Rechteprüfung ausschließlich über `can()`. Ein Lint-Test schlägt fehl, wenn eine Route keine Prüfung deklariert.
- Rich-Text wird als Tiptap-JSON gespeichert und über ein festes Schema gerendert. Kein HTML von Benutzern.
- Anhänge werden mit `Content-Disposition: attachment` und `nosniff` ausgeliefert, Bilder ausgenommen nach Typprüfung.
- CSRF: `SameSite=Lax`-Cookie und Origin-Prüfung bei schreibenden Anfragen.
- Ratenbegrenzung auf Login, Portal-Registrierung und die Abfrage-Engine.
- Webhooks und Mail-Abruf: keine Ziele in privaten Netzen, außer der Admin erlaubt es ausdrücklich.
- Die Abfrage-Engine bekommt eine eigene Angriffssuite als Test (siehe TODO Q-6).

---

## 11. Umfang

Der volle Funktionsumfang großer etablierter Werkzeuge ist das Ergebnis von über zwanzig Jahren. Der Plan liefert den Teil, den Teams täglich benutzen, in vier Meilensteinen. Jeder ist für sich benutzbar.

| Meilenstein | Ergebnis |
| --- | --- |
| **M1 Tickvana** | Projekte, Tickets, Felder, Workflows, Rechte, Suche per SQL, Boards, Sprints |
| **M2 Service-Desk** | Portal, Anfragetypen, Kunden, Queues, SLAs, Mail rein und raus, Automationen |
| **M3 Nuvenna** | Spaces, Seitenbaum, gleichzeitiges Bearbeiten, Versionen, Kommentare, Rechte |
| **M4 Verbund** | Ticket- und Abfrage-Blöcke im Wiki, Rückverweise, Wissensdatenbank im Portal, Dashboards, Branding fertig |

Bewusst nicht im Plan, bis jemand es braucht:

- Plugin-System und Marktplatz
- Import aus anderen Ticket- und Wiki-Systemen (ein eigenes Projekt, nach M4 das Erste)
- LDAP, SAML (OIDC deckt die meisten Fälle über einen Identity-Provider)
- S3-Speicher, Meilisearch, mehrere Nuvenna-Instanzen
- MSSQL, Oracle
- Roadmaps über mehrere Projekte, Assets/CMDB, Whiteboards, Diagramm-Editor
- Mobile Apps (die Weboberfläche ist responsiv)
- PDF-Erzeugung auf dem Server (Druck-CSS im Browser reicht zunächst)
- Skripte in Workflows

---

## 12. Tests

- **Einheit:** vitest, neben dem Code.
- **Integration:** gegen echte Datenbanken per Testcontainers, Matrix PostgreSQL und MariaDB. Keine DB-Mocks.
- **Rechte:** Tabellentest „Rolle × Recht × Ziel“ für Tickvana und Nuvenna.
- **Abfrage-Engine:** Angriffssuite plus Gleichheitstest „Ergebnis der Engine = Ergebnis der API für denselben Benutzer“.
- **Ende zu Ende:** Playwright, wenige durchgehende Abläufe (Ticket anlegen bis schließen, Portalanfrage bis Antwort, zwei Browser auf einer Seite).
