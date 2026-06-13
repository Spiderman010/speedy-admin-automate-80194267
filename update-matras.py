#!/usr/bin/env python3
"""Update matras pages on agiocleaning.nl via WordPress REST API.

Gebruik:
  export WP_APP_PASSWORD="jouw application password"
  python3 update-matras.py
"""

import base64
import json
import urllib.request
import urllib.error
import os
import sys

USER = "AgioCleaning"
PASS = os.environ.get("WP_APP_PASSWORD", "")
BASE = "https://agiocleaning.nl/wp-json/wp/v2"

if not PASS:
    print("❌ Stel eerst het wachtwoord in:")
    print('   export WP_APP_PASSWORD="jouw application password"')
    sys.exit(1)

token = base64.b64encode(f"{USER}:{PASS}".encode()).decode()
headers = {
    "Authorization": f"Basic {token}",
    "Content-Type": "application/json",
}


def make_content(stad, regio):
    return f"""<!-- wp:paragraph -->
<p>Woont u in <strong>{stad}</strong> of de omgeving van <strong>{regio}</strong> en heeft u een matras nodig dat grondig gereinigd wordt? Agio Cleaning reinigt matrassen van particulieren en bedrijven in de gehele regio snel, veilig en effectief.</p>
<!-- /wp:paragraph -->

<!-- wp:heading {{"level":2}} -->
<h2>Waarom uw matras laten reinigen?</h2>
<!-- /wp:heading -->

<!-- wp:paragraph -->
<p>Een matras herbergt gemiddeld <strong>2 miljoen huisstofmijten</strong> en kilo's huidschilfers per jaar. Professionele reiniging verwijdert:</p>
<!-- /wp:paragraph -->

<!-- wp:list -->
<ul>
<li>Huisstofmijten en allergenen</li>
<li>Zweet- en lichaamsvloeistoffen</li>
<li>Vlekken (bloed, urine, koffie)</li>
<li>Geuren en bacteriën</li>
</ul>
<!-- /wp:list -->

<!-- wp:heading {{"level":2}} -->
<h2>Onze werkwijze</h2>
<!-- /wp:heading -->

<!-- wp:paragraph -->
<p>Wij werken met professionele heetstoomapparatuur en HEPA-filtratie. Het matras wordt behandeld op <strong>temperaturen boven 60°C</strong> — dodelijk voor alle mijten en bacteriën.</p>
<!-- /wp:paragraph -->

<!-- wp:list -->
<ul>
<li>✅ <strong>HEPA-stofzuiging</strong> — diepte reiniging van binnenuit</li>
<li>✅ <strong>Heetstoombehandeling</strong> — 60°C+ doodt mijten &amp; bacteriën</li>
<li>✅ <strong>Vlekkenverwijdering</strong> — biologische enzymen</li>
<li>✅ <strong>UV-desinfectie</strong> — extra hygiëne-garantie</li>
<li>✅ <strong>Sneldroging</strong> — matras dezelfde dag nog bruikbaar</li>
</ul>
<!-- /wp:list -->

<!-- wp:heading {{"level":2}} -->
<h2>Veelgestelde vragen over matrasreiniging in {stad}</h2>
<!-- /wp:heading -->

<!-- wp:heading {{"level":3}} -->
<h3>Wat kost matrasreiniging?</h3>
<!-- /wp:heading -->
<!-- wp:paragraph -->
<p>De prijs hangt af van het formaat en de mate van vervuiling. Eenpersoons matrassen starten vanaf <strong>€ 59</strong>, tweepersoons vanaf <strong>€ 89</strong>. Vraag een gratis offerte aan via onze website of bel ons.</p>
<!-- /wp:paragraph -->

<!-- wp:heading {{"level":3}} -->
<h3>Hoe lang duurt de reiniging?</h3>
<!-- /wp:heading -->
<!-- wp:paragraph -->
<p>Een volledige behandeling duurt gemiddeld <strong>60–90 minuten</strong>. Daarna is het matras binnen 2–3 uur volledig droog en direct bruikbaar.</p>
<!-- /wp:paragraph -->

<!-- wp:heading {{"level":3}} -->
<h3>Komt u bij mij thuis in {stad}?</h3>
<!-- /wp:heading -->
<!-- wp:paragraph -->
<p>Ja! Wij komen altijd <strong>bij u thuis</strong>. U hoeft het matras nergens naartoe te brengen. Wij reinigen het matras op locatie in {stad} en omgeving.</p>
<!-- /wp:paragraph -->

<!-- wp:heading {{"level":3}} -->
<h3>Werkt u ook voor bedrijven?</h3>
<!-- /wp:heading -->
<!-- wp:paragraph -->
<p>Absoluut. Wij reinigen matrassen voor hotels, pensions, zorginstellingen en verhuurwoningen in de regio {regio}.</p>
<!-- /wp:paragraph -->

<!-- wp:heading {{"level":3}} -->
<h3>Hoe snel kunt u komen?</h3>
<!-- /wp:heading -->
<!-- wp:paragraph -->
<p>In de meeste gevallen zijn wij er <strong>binnen 24–48 uur</strong>. Spoed mogelijk — bel ons voor beschikbaarheid.</p>
<!-- /wp:paragraph -->

<!-- wp:heading {{"level":3}} -->
<h3>Is de reiniging veilig voor kinderen en huisdieren?</h3>
<!-- /wp:heading -->
<!-- wp:paragraph -->
<p>Ja. Wij gebruiken <strong>biologisch afbreekbare, niet-toxische middelen</strong>. Na het drogen (2–3 uur) is het matras volledig veilig.</p>
<!-- /wp:paragraph -->

<!-- wp:heading {{"level":3}} -->
<h3>Verwijdert u ook urinevlekken?</h3>
<!-- /wp:heading -->
<!-- wp:paragraph -->
<p>Ja, ook hardnekkige urinevlekken en -geuren pakken wij aan met enzymatische reinigingsmiddelen die de moleculen afbreken.</p>
<!-- /wp:paragraph -->

<!-- wp:heading {{"level":3}} -->
<h3>Heeft u een KvK-nummer?</h3>
<!-- /wp:heading -->
<!-- wp:paragraph -->
<p>Ja. Agio Cleaning is ingeschreven bij de Kamer van Koophandel. Vraag ons nummer op via het contactformulier.</p>
<!-- /wp:paragraph -->

<!-- wp:heading {{"level":2}} -->
<h2>Direct contact</h2>
<!-- /wp:heading -->

<!-- wp:paragraph -->
<p>📞 <strong>Bel ons:</strong> <a href="tel:0850290845">085 - 029 0845</a><br>
💬 <strong>WhatsApp:</strong> <a href="https://wa.me/310850290845">Stuur een bericht</a><br>
📋 <strong>Offerte:</strong> <a href="/contact">Vraag gratis offerte aan</a></p>
<!-- /wp:paragraph -->

<!-- wp:html -->
<script type="application/ld+json">
{{
  "@context": "https://schema.org",
  "@graph": [
    {{
      "@type": "LocalBusiness",
      "name": "Agio Cleaning",
      "description": "Professionele matrasreiniging in {stad} en omgeving",
      "url": "https://agiocleaning.nl",
      "telephone": "085-0290845",
      "address": {{
        "@type": "PostalAddress",
        "addressRegion": "{regio}",
        "addressCountry": "NL"
      }},
      "areaServed": "{stad}"
    }},
    {{
      "@type": "FAQPage",
      "mainEntity": [
        {{"@type":"Question","name":"Wat kost matrasreiniging?","acceptedAnswer":{{"@type":"Answer","text":"Eenpersoons vanaf € 59, tweepersoons vanaf € 89. Gratis offerte op aanvraag."}}}},
        {{"@type":"Question","name":"Hoe lang duurt de reiniging?","acceptedAnswer":{{"@type":"Answer","text":"Gemiddeld 60–90 minuten, daarna 2–3 uur drogen."}}}},
        {{"@type":"Question","name":"Komt u bij mij thuis?","acceptedAnswer":{{"@type":"Answer","text":"Ja, wij reinigen altijd op locatie bij u thuis in {stad}."}}}},
        {{"@type":"Question","name":"Is de reiniging veilig voor kinderen?","acceptedAnswer":{{"@type":"Answer","text":"Ja, wij gebruiken biologisch afbreekbare niet-toxische middelen."}}}}
      ]
    }}
  ]
}}
</script>
<!-- /wp:html -->"""


PAGES = [
    {"id": 1210, "stad": "Nissewaard", "regio": "Zuid-Holland Zuid"},
    {"id": 1208, "stad": "Westland",   "regio": "Westland / Den Haag"},
]


def update_page(page_id, stad, regio):
    content = make_content(stad, regio)
    payload = json.dumps({"content": content}).encode()
    req = urllib.request.Request(
        f"{BASE}/pages/{page_id}",
        data=payload,
        headers=headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(req) as resp:
            data = json.loads(resp.read())
            print(f"✅ Pagina {page_id} ({stad}) bijgewerkt — {data.get('link', '')}")
    except urllib.error.HTTPError as e:
        print(f"❌ Fout bij pagina {page_id}: {e.code} {e.reason}")
        print(e.read().decode())


if __name__ == "__main__":
    for p in PAGES:
        update_page(p["id"], p["stad"], p["regio"])
