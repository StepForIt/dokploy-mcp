# Sécuriser Dokploy et ses secrets

> Récap des décisions d'octobre 2026. **Priorité 1 : le VPN** (§ 1), le reste suit dans l'ordre du § 7.

## En 30 secondes

```
Aujourd'hui                                  Cible
───────────                                  ─────
Internet ──► panel Dokploy (public)          Internet ──► 80/443 des apps seulement
Internet ──► SSH 22 (public)                 Mac ──VPN──► panel Dokploy + SSH
Base Dokploy : secrets en clair              Base Dokploy : références ${{vault.…}}
                                             Vault (autre serveur) : les valeurs
Rien ne surveille le serveur                 CrowdSec + Falco, riposte depuis l'extérieur
```

| Risque | Parade | Section |
| --- | --- | --- |
| Quelqu'un entre par le panel ou SSH | VPN Tailscale, panel et SSH fermés au public | § 1 |
| Dokploy tombe, les clés sont perdues | les valeurs vivent dans Vault | § 2 |
| Dokploy est cracké, tout fuit | jetons cloisonnés, clés à plafond, jeton à la demande | § 3, § 4 |
| On ne voit pas l'intrusion | CrowdSec, Falco, alerte qui révoque | § 5 |

---

## 1. Panel Dokploy et SSH derrière un VPN (PRIORITÉ)

### Le choix : Tailscale

| | Tailscale | NetBird | WireGuard brut |
| --- | --- | --- | --- |
| Installation | 5 min par appareil | 5 min, ou auto-hébergé | 1 h, clés à la main |
| App Mac | oui (App Store) | oui | oui |
| Prix à ta taille | gratuit (jusqu'à 3 utilisateurs, 100 appareils) | gratuit | gratuit |
| Hébergement de la coordination | Tailscale (US) | NetBird (DE) ou chez toi | chez toi |
| **Verdict** | **le plus simple, recommandé** | si tu veux l'auto-héberger plus tard | trop manuel |

Le trafic est chiffré de bout en bout (WireGuard) : Tailscale ne voit pas ce qui passe, il distribue seulement les clés.

### Ce que ça change

```
Avant   Internet ─────────────────► VPS :22 (SSH), :3000 et dokploy.domaine (panel)
Après   Mac (Tailscale) ══tunnel══► VPS 100.x.y.z :22, :3000
        Internet ─────────────────► VPS :80, :443 (les apps) — le reste est fermé
```

### Avant de commencer (5 min, évite de t'enfermer dehors)

- [ ] Ouvrir la **console KVM** du VPS dans le manager OVH et vérifier qu'elle marche : c'est la porte de secours si SSH ne répond plus.
- [ ] Noter qui appelle l'API Dokploy par son adresse publique, car il faudra le rebrancher (§ 1.5) :
  - le provisioner Wappe ;
  - les serveurs MCP Dokploy (connecteurs Claude) ;
  - les webhooks GitHub d'auto-déploiement, s'il y en a.
- [ ] Faire tout ça sur **un** serveur Dokploy d'abord, puis le second.

### 1.1 Le Mac (2 min)

1. Installer **Tailscale** depuis le Mac App Store (ou `brew install --cask tailscale`).
2. Se connecter avec ton compte Google ou GitHub.
3. **Activer la 2FA sur ce compte** : le VPN vaut ce que vaut cette connexion.

### 1.2 Le VPS (3 min, en SSH comme aujourd'hui)

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up            # ouvre un lien : le valider depuis le Mac
tailscale ip -4              # note l'adresse 100.x.y.z
```

Puis dans la console Tailscale (login.tailscale.com → Machines → le VPS) : **Disable key expiry**. Sans ça, le serveur sort du VPN au bout de 180 jours.

Optionnel : renommer la machine (`dokploy-1`), pour taper `ssh root@dokploy-1` au lieu de l'IP.

### 1.3 Tester depuis le Mac, AVANT de fermer quoi que ce soit

```bash
ssh root@100.x.y.z                         # doit marcher
open http://100.x.y.z:3000                 # le panel Dokploy doit s'afficher
```

Le `http` est normal : le tunnel est déjà chiffré.

### 1.4 Fermer au public

Point important : **Docker contourne `ufw`** pour les ports qu'il publie, dont le 3000 du panel. Un `ufw deny 3000` ne protège donc rien. On ferme au niveau du réseau OVH, hors du serveur, ce qu'un attaquant sur le VPS ne peut pas annuler.

**Pare-feu réseau OVH** (manager → Bare Metal Cloud → IP → l'IP du VPS → Network Firewall → activer). Règles, dans l'ordre :

| Priorité | Action | Protocole | Port destination | Pour quoi |
| --- | --- | --- | --- | --- |
| 0 | Autoriser | TCP | 80 | apps |
| 1 | Autoriser | TCP | 443 | apps |
| 2 | Autoriser | UDP | 41641 | Tailscale en direct (sinon il passe par un relais, plus lent mais ça marche) |
| 3 | Autoriser | TCP established | | réponses aux connexions sortantes |
| 4 | Autoriser | UDP | (port source 53, 123) | DNS, heure |
| 19 | **Refuser** | IPv4 | tout | le reste, dont 22 et 3000 |

> À vérifier sur ton offre : le pare-feu réseau OVH n'est pas disponible sur toutes les gammes de VPS. S'il manque, on bloque dans la chaîne `DOCKER-USER` d'iptables (on le valide ensemble avant, Docker Swarm a ses particularités).

**Panel Dokploy** : dans Dokploy → Settings → Server, retirer le domaine public du panel. On y accède par `http://100.x.y.z:3000`.

**SSH** (`/etc/ssh/sshd_config`) :

```
PasswordAuthentication no
PermitRootLogin prohibit-password
```

puis `sudo systemctl reload ssh`. On ne restreint pas l'écoute de sshd à l'IP Tailscale : si Tailscale démarre mal au boot, sshd ne démarrerait plus. Le pare-feu OVH suffit.

### 1.5 Rebrancher ce qui appelait le panel public

| Appelant | Où il tourne | Nouvelle adresse |
| --- | --- | --- |
| Provisioner, MCP Dokploy | sur le même serveur Dokploy | `http://dokploy:3000` (réseau Docker `dokploy-network`), rien ne sort |
| Un outil sur un autre serveur | ailleurs | installer Tailscale sur ce serveur, puis `http://100.x.y.z:3000` |
| Webhooks GitHub d'auto-déploiement | GitHub | ne passent plus : déployer par le provisioner (c'est déjà le cas pour Wappe) |

### 1.6 Vérifier que c'est fermé

Depuis le téléphone **en 4G, Tailscale coupé** :

```bash
nc -vz <IP publique> 22      # doit échouer
nc -vz <IP publique> 3000    # doit échouer
curl -I https://wappe.me     # doit répondre
```

Puis Tailscale allumé : SSH et panel répondent sur 100.x.y.z.

### Impacts

| Ce qui change | Pour qui |
| --- | --- |
| Panel et SSH accessibles **seulement** depuis un appareil Tailscale | toi, Mild s'il a besoin du panel (l'inviter dans le tailnet) |
| Plus d'auto-déploiement Dokploy déclenché par GitHub | déploiements par le provisioner |
| Si Tailscale tombe chez eux | console KVM OVH en secours, ou rouvrir 22 temporairement dans le pare-feu OVH |

---

## 2. Les secrets dans Vault

Depuis la v0.30, Dokploy lit un coffre au **déploiement** : l'env ne contient plus que `${{vault.<provider>.<chemin>:<CLÉ>}}`. L'outil `env-migrate-to-vault` de ce MCP fait le passage, dans un seul sens (cf. README).

```
Dokploy (références)  ──au déploiement──►  Vault (valeurs)  ──►  conteneur (clair en mémoire)
```

| Question | Réponse |
| --- | --- |
| Les secrets sont-ils encore en clair quelque part ? | Oui : le `.env` écrit par Dokploy sur l'hôte et le conteneur. Plus dans la base Dokploy, l'interface ni ses sauvegardes |
| Un jeton Vault fuit, tout fuit ? | Non : il ouvre ce que sa politique autorise. Une politique par jeton, bornée aux chemins utiles, jamais le root token |
| Lier un jeton à un appareil ? | Par IP oui (`-bound-cidr`). Par appareil (certificat, AppRole) : Dokploy ne sait présenter qu'un jeton |
| Secret partagé (clé Mistral globale) ? | Un chemin commun : `path: "shared"`, toutes les instances pointent `${{vault.wappe.shared:AI_API_KEY}}` |
| Vault redémarre ? | Il est **scellé** : plus aucun déploiement ne passe jusqu'au descellement (les conteneurs en place tournent). Auto-unseal plus tard |

Règles : Vault **jamais** sur un serveur Dokploy ; portions de clé de descellement **jamais** sur un serveur ; `SECRETS_KEY` de chaque instance aussi en copie froide (1Password).

## 3. Si Dokploy est cracké : limiter la fuite

L'attaquant ne descelle pas Vault (les portions de clé sont chez toi). Il récupère les **jetons stockés dans Dokploy** et les **secrets des conteneurs de ce serveur**.

| # | Levier | Effet |
| --- | --- | --- |
| 1 | Vault sur un autre serveur, joignable seulement depuis l'IP de Dokploy | stockage et clés hors d'atteinte |
| 2 | Un provider (et un jeton) par environnement, borné en IP | un jeton volé n'ouvre qu'une tranche. Dev et prod sur deux Dokploy |
| 3 | Clés tierces à petit rayon : une clé Mistral par instance avec plafond, Stripe restreinte, `SECRETS_KEY` distincte | une fuite coûte un plafond, se révoque seule |
| 4 | Pas de jeton d'écriture permanent : `VAULT_TOKEN` du MCP révoqué après migration | impossible de réécrire ou piéger les secrets |
| 5 | Audit Vault (`vault audit enable file`) + alerte | on sait ce qui a été lu, donc quoi tourner |
| 6 | Procédure d'incident : révoquer, tourner, recréer, redéployer | fenêtre d'exploitation : 1 h au lieu de jours |

## 4. Verrous contre une lecture massive

| Verrou | Arrête une fuite | Gêne les déploiements |
| --- | --- | --- |
| Quota de débit Vault (natif) | en partie | si le seuil est trop bas |
| Script d'audit qui révoque sur anomalie | oui, en secondes | non |
| **Jeton à la demande** : jeton mort au repos, le provisioner crée un jeton de 10 min, déploie, le révoque | **presque totalement** | seulement hors provisioner |

Filet immédiat, réglé large pour ne pas casser un déploiement du parc :

```bash
vault write sys/quotas/rate-limit/dokploy-read path="secret/data/wappe" rate=50 interval=1s block_interval=15m
```

## 5. Détecter et riposter sur le VPS

Un attaquant root peut couper les défenses locales : l'alerte doit **sortir** de la machine, et la riposte partir **de l'extérieur**.

```
Falco (shell dans un conteneur, lecture de .env, docker exec)
   └─► Falcosidekick ─► webhook hors VPS ─┬─► Vault révoque les jetons Dokploy
                                          ├─► pare-feu OVH coupe le sortant
                                          └─► alerte à Mathieu
CrowdSec (SSH, Traefik) ─► bannit les IP qui sondent
```

| Outil | Rôle | Effort |
| --- | --- | --- |
| CrowdSec (français, gratuit) + bouncer Traefik | bannit les IP agressives | 1 h |
| Falco + Falcosidekick | voit les gestes suspects dans les conteneurs, déclenche la riposte | ½ journée |
| Wazuh | surveillance complète | lourd pour un VPS |

## 6. Ce qu'aucun outil ne règle

Root sur un serveur voit en clair les secrets de **ses** conteneurs. On en limite le **nombre** (séparer les serveurs) et la **valeur** (clés à plafond).

## 7. Ordre de mise en place

| # | Action | Effort | Gain |
| --- | --- | --- | --- |
| 1 | **VPN Tailscale, panel et SSH fermés au public (§ 1)** | 1 h par serveur | ferme la porte d'entrée la plus probable |
| 2 | 2FA Dokploy, SSH par clé seule | 10 min | |
| 3 | Test Vault sur un projet non critique (6 étapes, cf. PR #8) | 1 h | valide la migration |
| 4 | Révoquer le jeton MCP d'écriture après migration | 1 min | |
| 5 | Jeton Dokploy : politique étroite, borné en IP, audit Vault, quota | 30 min | |
| 6 | CrowdSec | 1 h | |
| 7 | Migration du parc, clé Mistral en `shared` | ½ journée | |
| 8 | Jeton à la demande dans le provisioner | 1 journée | Dokploy au repos ne lit plus rien |
| 9 | Falco + riposte | ½ journée | |
| 10 | Séparer dev et prod sur deux Dokploy | selon parc | |
