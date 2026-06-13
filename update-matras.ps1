$user = "AgioCleaning"
$pass = $env:WP_APP_PASSWORD   # stel in via: $env:WP_APP_PASSWORD = "jouw application password"
$base64 = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("${user}:${pass}"))
$headers = @{ Authorization = "Basic $base64"; "Content-Type" = "application/json" }

# ── NISSEWAARD (ID 1210) ──────────────────────────────────────────────────────
$nissewaard = @{
  title   = "Matras reinigen in Nissewaard — vaste prijs vooraf, droog binnen 12 tot 24 uur"
  content = @"
<p>Van de rijtjeswoningen in Nieuwland tot de appartementen in Groenoord — Nissewaard heeft veel verschillende woningtypen. Na jaren van dagelijks gebruik bevat een matras tot 2 miljoen huisstofmijten, zweet en huidschilfers. Agio Cleaning reinigt matrassen bij u thuis in Nieuwland, Groenoord, Spaland en omliggende wijken — met sproei-extractie, vaste prijs vooraf en geen voorrijkosten in Zuid-Holland.</p>

<h2>Vaste tarieven matrasreiniging in Nissewaard</h2>
<p>Onze tarieven zijn vast en inclusief btw. Geen voorrijkosten in Zuid-Holland.</p>
<table>
<thead><tr><th>Type matras</th><th>Vaste prijs incl. btw</th></tr></thead>
<tbody>
<tr><td>Kindermatras</td><td>€ 30,–</td></tr>
<tr><td>Eenpersoons</td><td>€ 45,–</td></tr>
<tr><td>Tweepersoons</td><td>€ 69,50</td></tr>
<tr><td>Topdek eenpersoons</td><td>€ 45,–</td></tr>
<tr><td>Topdek tweepersoons</td><td>€ 69,50</td></tr>
</tbody>
</table>
<p><strong>Meerdere matrassen tegelijk?</strong> Als u twee of meer matrassen op dezelfde dag laat reinigen, ontvangt u korting. Vraag ernaar bij het boeken.</p>

<h2>Waarom kiezen voor Agio Cleaning in Nissewaard?</h2>
<ul>
<li><strong>Reactie binnen één werkdag</strong> — meestal kunnen wij binnen een week bij u langs.</li>
<li><strong>Vaste prijs vooraf</strong> — geen verrassingen achteraf, geen voorrijkosten.</li>
<li><strong>14 dagen tevredenheidsgarantie</strong> — is er iets niet naar wens, dan komen wij kosteloos terug.</li>
<li><strong>Verzekerd werk</strong> volgens NL-vakvoorwaarden, KvK 90525922.</li>
<li><strong>Veilige reinigingsmiddelen</strong> — na droging veilig voor kinderen en huisdieren.</li>
</ul>

<h2>Hoe gaan wij te werk?</h2>
<ol>
<li><strong>Beoordeling</strong> van het matras, vlekken en uw verwachtingen.</li>
<li><strong>Voorbehandeling</strong> van hardnekkig vuil met een passend reinigingsmiddel.</li>
<li><strong>Dieptereiniging</strong> met sproei-extractie — warm water in, vuil eruit.</li>
<li><strong>Na-inspectie</strong> samen met u.</li>
</ol>
<p>Per matras rekenen we 30 tot 60 minuten. Het matras is droog binnen 12 tot 24 uur.</p>

<h2>Veelgestelde vragen over matrasreiniging in Nissewaard</h2>
<p><strong>Wat kost matrasreiniging in Nissewaard?</strong><br />
Kindermatras € 30, eenpersoons € 45, tweepersoons € 69,50. Vaste prijs vooraf, geen verrassingen.</p>

<p><strong>Hoe lang duurt het voordat het matras droog is?</strong><br />
Meestal 12 tot 24 uur, afhankelijk van het materiaal en de ventilatie in de slaapkamer.</p>

<p><strong>Werken jullie ook in Groenoord en Spaland?</strong><br />
Ja, we rijden door heel Nissewaard. Geen extra kosten voor specifieke wijken.</p>

<p><strong>Kunnen jullie meerdere matrassen op één dag doen?</strong><br />
Ja, en bij meerdere matrassen of diensten op één dag ontvangt u korting. Geef het aan bij het boeken.</p>

<p><strong>Reinigen jullie ook boxsprings en topmatrasjes?</strong><br />
Ja. Stuur gerust een foto via WhatsApp voor advies en een vaste prijs.</p>

<p><strong>Zijn de reinigingsmiddelen veilig voor kinderen en huisdieren?</strong><br />
Ja. We werken met middelen die na droging volledig veilig zijn voor kinderen en huisdieren.</p>

<p><strong>Moeten we het bed helemaal afbreken?</strong><br />
Nee, we hoeven alleen het matras los te leggen. Wij tillen het voor u.</p>

<p><strong>Kunnen jullie matras én bank op dezelfde dag doen?</strong><br />
Ja, en u ontvangt dan korting. Geef het aan bij het boeken.</p>

<h2>Direct matrasreiniging plannen in Nissewaard</h2>
<ul>
<li>📞 Direct bellen: <a href="tel:+31103073790">010 307 37 90</a></li>
<li>💬 <a href="https://wa.me/31682045451" target="_blank" rel="noopener">WhatsApp ons een foto van uw matras</a></li>
<li>📝 <a href="https://agiocleaning.nl/offerte/?dienst=Matrasreiniging">Vraag direct een vaste prijs aan</a></li>
</ul>
<p>U ontvangt meestal binnen één werkdag een vaste prijs en voorstel voor uw matrasreiniging.</p>

<h2>Andere diensten in Nissewaard</h2>
<ul>
<li><a href="/bank-reinigen-nissewaard">Bank reinigen Nissewaard</a></li>
<li><a href="/tapijtreiniging-nissewaard">Tapijtreiniging Nissewaard</a></li>
<li><a href="https://agiocleaning.nl/matras-laten-reinigen/">Alle informatie over matrasreiniging</a></li>
</ul>

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "LocalBusiness",
      "@id": "https://agiocleaning.nl/matras-reinigen-nissewaard#business",
      "name": "Agio Cleaning",
      "legalName": "Agio Matras Cleaning B.V.",
      "telephone": "+31103073790",
      "url": "https://agiocleaning.nl/matras-reinigen-nissewaard",
      "areaServed": [
        { "@type": "City", "name": "Nissewaard" },
        { "@type": "Place", "name": "Nieuwland" },
        { "@type": "Place", "name": "Groenoord" },
        { "@type": "Place", "name": "Spaland" }
      ],
      "address": { "@type": "PostalAddress", "addressRegion": "Zuid-Holland", "addressCountry": "NL" },
      "identifier": "KVK:90525922"
    },
    {
      "@type": "Service",
      "name": "Matrasreiniging Nissewaard",
      "provider": { "@id": "https://agiocleaning.nl/matras-reinigen-nissewaard#business" },
      "areaServed": { "@type": "City", "name": "Nissewaard" },
      "serviceType": "Matrasreiniging",
      "offers": { "@type": "Offer", "priceCurrency": "EUR", "price": "45.00" }
    }
  ]
}
</script>

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "mainEntity": [
    {
      "@type": "Question",
      "name": "Wat kost matrasreiniging in Nissewaard?",
      "acceptedAnswer": { "@type": "Answer", "text": "Kindermatras € 30, eenpersoons € 45, tweepersoons € 69,50. Vaste prijs vooraf, geen verrassingen." }
    },
    {
      "@type": "Question",
      "name": "Hoe lang duurt het voordat het matras droog is?",
      "acceptedAnswer": { "@type": "Answer", "text": "Meestal 12 tot 24 uur, afhankelijk van het materiaal en de ventilatie in de slaapkamer." }
    },
    {
      "@type": "Question",
      "name": "Werken jullie ook in Groenoord en Spaland?",
      "acceptedAnswer": { "@type": "Answer", "text": "Ja, we rijden door heel Nissewaard. Geen extra kosten voor specifieke wijken." }
    },
    {
      "@type": "Question",
      "name": "Kunnen jullie meerdere matrassen op één dag doen?",
      "acceptedAnswer": { "@type": "Answer", "text": "Ja, en bij meerdere matrassen of diensten op één dag ontvangt u korting. Geef het aan bij het boeken." }
    },
    {
      "@type": "Question",
      "name": "Reinigen jullie ook boxsprings en topmatrasjes?",
      "acceptedAnswer": { "@type": "Answer", "text": "Ja. Stuur gerust een foto via WhatsApp voor advies en een vaste prijs." }
    },
    {
      "@type": "Question",
      "name": "Zijn de reinigingsmiddelen veilig voor kinderen en huisdieren?",
      "acceptedAnswer": { "@type": "Answer", "text": "Ja. We werken met middelen die na droging volledig veilig zijn voor kinderen en huisdieren." }
    },
    {
      "@type": "Question",
      "name": "Moeten we het bed helemaal afbreken?",
      "acceptedAnswer": { "@type": "Answer", "text": "Nee, we hoeven alleen het matras los te leggen. Wij tillen het voor u." }
    },
    {
      "@type": "Question",
      "name": "Kunnen jullie matras én bank op dezelfde dag doen?",
      "acceptedAnswer": { "@type": "Answer", "text": "Ja, en u ontvangt dan korting. Geef het aan bij het boeken." }
    }
  ]
}
</script>
"@
} | ConvertTo-Json -Depth 5

Invoke-RestMethod -Method PUT `
  -Uri "https://agiocleaning.nl/wp-json/wp/v2/pages/1210" `
  -Headers $headers `
  -Body ($nissewaard | ConvertTo-Json -Depth 5)

Write-Host "✅ Nissewaard matras pagina bijgewerkt (ID 1210)"

# ── WESTLAND (ID 1208) ────────────────────────────────────────────────────────
$westland = @{
  title   = "Matras reinigen in Westland — vaste prijs vooraf, droog binnen 12 tot 24 uur"
  content = @"
<p>Van de kassen en tuinbouwbedrijven tot de woonwijken in Naaldwijk en Wateringen — Westland is een gemeente met een eigen karakter. Na jaren van dagelijks gebruik bevat een matras tot 2 miljoen huisstofmijten, zweet en huidschilfers. Agio Cleaning reinigt matrassen bij u thuis in Naaldwijk, Wateringen, De Lier en omliggende kernen — met sproei-extractie, vaste prijs vooraf en geen voorrijkosten in Zuid-Holland.</p>

<h2>Vaste tarieven matrasreiniging in Westland</h2>
<p>Onze tarieven zijn vast en inclusief btw. Geen voorrijkosten in Zuid-Holland.</p>
<table>
<thead><tr><th>Type matras</th><th>Vaste prijs incl. btw</th></tr></thead>
<tbody>
<tr><td>Kindermatras</td><td>€ 30,–</td></tr>
<tr><td>Eenpersoons</td><td>€ 45,–</td></tr>
<tr><td>Tweepersoons</td><td>€ 69,50</td></tr>
<tr><td>Topdek eenpersoons</td><td>€ 45,–</td></tr>
<tr><td>Topdek tweepersoons</td><td>€ 69,50</td></tr>
</tbody>
</table>
<p><strong>Meerdere matrassen tegelijk?</strong> Als u twee of meer matrassen op dezelfde dag laat reinigen, ontvangt u korting. Vraag ernaar bij het boeken.</p>

<h2>Waarom kiezen voor Agio Cleaning in Westland?</h2>
<ul>
<li><strong>Reactie binnen één werkdag</strong> — meestal kunnen wij binnen een week bij u langs.</li>
<li><strong>Vaste prijs vooraf</strong> — geen verrassingen achteraf, geen voorrijkosten.</li>
<li><strong>14 dagen tevredenheidsgarantie</strong> — is er iets niet naar wens, dan komen wij kosteloos terug.</li>
<li><strong>Verzekerd werk</strong> volgens NL-vakvoorwaarden, KvK 90525922.</li>
<li><strong>Veilige reinigingsmiddelen</strong> — na droging veilig voor kinderen en huisdieren.</li>
</ul>

<h2>Hoe gaan wij te werk?</h2>
<ol>
<li><strong>Beoordeling</strong> van het matras, vlekken en uw verwachtingen.</li>
<li><strong>Voorbehandeling</strong> van hardnekkig vuil met een passend reinigingsmiddel.</li>
<li><strong>Dieptereiniging</strong> met sproei-extractie — warm water in, vuil eruit.</li>
<li><strong>Na-inspectie</strong> samen met u.</li>
</ol>
<p>Per matras rekenen we 30 tot 60 minuten. Het matras is droog binnen 12 tot 24 uur.</p>

<h2>Veelgestelde vragen over matrasreiniging in Westland</h2>
<p><strong>Wat kost matrasreiniging in Westland?</strong><br />
Kindermatras € 30, eenpersoons € 45, tweepersoons € 69,50. Vaste prijs vooraf, geen verrassingen.</p>

<p><strong>Hoe lang duurt het voordat het matras droog is?</strong><br />
Meestal 12 tot 24 uur, afhankelijk van het materiaal en de ventilatie in de slaapkamer.</p>

<p><strong>Werken jullie ook in Naaldwijk, Wateringen en De Lier?</strong><br />
Ja, we rijden door heel Westland. Geen extra kosten voor specifieke kernen.</p>

<p><strong>Kunnen jullie meerdere matrassen op één dag doen?</strong><br />
Ja, en bij meerdere matrassen of diensten op één dag ontvangt u korting. Geef het aan bij het boeken.</p>

<p><strong>Reinigen jullie ook boxsprings en topmatrasjes?</strong><br />
Ja. Stuur gerust een foto via WhatsApp voor advies en een vaste prijs.</p>

<p><strong>Zijn de reinigingsmiddelen veilig voor kinderen en huisdieren?</strong><br />
Ja. We werken met middelen die na droging volledig veilig zijn voor kinderen en huisdieren.</p>

<p><strong>Moeten we het bed helemaal afbreken?</strong><br />
Nee, we hoeven alleen het matras los te leggen. Wij tillen het voor u.</p>

<p><strong>Kunnen jullie matras én bank op dezelfde dag doen?</strong><br />
Ja, en u ontvangt dan korting. Geef het aan bij het boeken.</p>

<h2>Direct matrasreiniging plannen in Westland</h2>
<ul>
<li>📞 Direct bellen: <a href="tel:+31103073790">010 307 37 90</a></li>
<li>💬 <a href="https://wa.me/31682045451" target="_blank" rel="noopener">WhatsApp ons een foto van uw matras</a></li>
<li>📝 <a href="https://agiocleaning.nl/offerte/?dienst=Matrasreiniging">Vraag direct een vaste prijs aan</a></li>
</ul>
<p>U ontvangt meestal binnen één werkdag een vaste prijs en voorstel voor uw matrasreiniging.</p>

<h2>Andere diensten in Westland</h2>
<ul>
<li><a href="/bank-reinigen-westland">Bank reinigen Westland</a></li>
<li><a href="/tapijtreiniging-westland">Tapijtreiniging Westland</a></li>
<li><a href="https://agiocleaning.nl/matras-laten-reinigen/">Alle informatie over matrasreiniging</a></li>
</ul>

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "LocalBusiness",
      "@id": "https://agiocleaning.nl/matras-reinigen-westland#business",
      "name": "Agio Cleaning",
      "legalName": "Agio Matras Cleaning B.V.",
      "telephone": "+31103073790",
      "url": "https://agiocleaning.nl/matras-reinigen-westland",
      "areaServed": [
        { "@type": "City", "name": "Westland" },
        { "@type": "Place", "name": "Naaldwijk" },
        { "@type": "Place", "name": "Wateringen" },
        { "@type": "Place", "name": "De Lier" }
      ],
      "address": { "@type": "PostalAddress", "addressRegion": "Zuid-Holland", "addressCountry": "NL" },
      "identifier": "KVK:90525922"
    },
    {
      "@type": "Service",
      "name": "Matrasreiniging Westland",
      "provider": { "@id": "https://agiocleaning.nl/matras-reinigen-westland#business" },
      "areaServed": { "@type": "City", "name": "Westland" },
      "serviceType": "Matrasreiniging",
      "offers": { "@type": "Offer", "priceCurrency": "EUR", "price": "45.00" }
    }
  ]
}
</script>

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "mainEntity": [
    {
      "@type": "Question",
      "name": "Wat kost matrasreiniging in Westland?",
      "acceptedAnswer": { "@type": "Answer", "text": "Kindermatras € 30, eenpersoons € 45, tweepersoons € 69,50. Vaste prijs vooraf, geen verrassingen." }
    },
    {
      "@type": "Question",
      "name": "Hoe lang duurt het voordat het matras droog is?",
      "acceptedAnswer": { "@type": "Answer", "text": "Meestal 12 tot 24 uur, afhankelijk van het materiaal en de ventilatie in de slaapkamer." }
    },
    {
      "@type": "Question",
      "name": "Werken jullie ook in Naaldwijk, Wateringen en De Lier?",
      "acceptedAnswer": { "@type": "Answer", "text": "Ja, we rijden door heel Westland. Geen extra kosten voor specifieke kernen." }
    },
    {
      "@type": "Question",
      "name": "Kunnen jullie meerdere matrassen op één dag doen?",
      "acceptedAnswer": { "@type": "Answer", "text": "Ja, en bij meerdere matrassen of diensten op één dag ontvangt u korting. Geef het aan bij het boeken." }
    },
    {
      "@type": "Question",
      "name": "Reinigen jullie ook boxsprings en topmatrasjes?",
      "acceptedAnswer": { "@type": "Answer", "text": "Ja. Stuur gerust een foto via WhatsApp voor advies en een vaste prijs." }
    },
    {
      "@type": "Question",
      "name": "Zijn de reinigingsmiddelen veilig voor kinderen en huisdieren?",
      "acceptedAnswer": { "@type": "Answer", "text": "Ja. We werken met middelen die na droging volledig veilig zijn voor kinderen en huisdieren." }
    },
    {
      "@type": "Question",
      "name": "Moeten we het bed helemaal afbreken?",
      "acceptedAnswer": { "@type": "Answer", "text": "Nee, we hoeven alleen het matras los te leggen. Wij tillen het voor u." }
    },
    {
      "@type": "Question",
      "name": "Kunnen jullie matras én bank op dezelfde dag doen?",
      "acceptedAnswer": { "@type": "Answer", "text": "Ja, en u ontvangt dan korting. Geef het aan bij het boeken." }
    }
  ]
}
</script>
"@
} | ConvertTo-Json -Depth 5

Invoke-RestMethod -Method PUT `
  -Uri "https://agiocleaning.nl/wp-json/wp/v2/pages/1208" `
  -Headers $headers `
  -Body ($westland | ConvertTo-Json -Depth 5)

Write-Host "✅ Westland matras pagina bijgewerkt (ID 1208)"
