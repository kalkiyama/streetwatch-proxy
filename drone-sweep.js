// StreetWatch — global drone sweep.
//
// Polls the UAV-watch airspaces on a slow rotation (one site at a time) and
// keeps every ADS-B category B6 (unmanned aerial vehicle) contact it sees.
// One sweep serves every user, so the app can show a planet-wide drone view
// without each client hammering the upstream API.
//
// Honest limits: this sees only drones that broadcast ADS-B (large military,
// government and test platforms) AND that a volunteer receiver can hear.
// Consumer drones use short-range Remote ID and never appear here.

const { fetchAircraft } = require("./adsb-proxy");
const archive = require("./archive.js");

// ICAO type designators for uncrewed platforms that often DON'T squawk category B6.
// Prefix match on MQ-/RQ- series covers Reaper, Predator, Triton, Global Hawk, Shadow…
const UAV_TYPE_RE = /^(MQ\d|RQ\d|TB2|ANKA|HRON|HERN|S100|WK45|SW4|GHWK)/i;

// Manufacturers of manned aircraft. ADS-B emitter category is SELF-DECLARED, so a
// mis-set transponder can broadcast "B6 / unmanned" from an ordinary Cessna. When the
// registry description names a manned airframe we keep the contact but mark it disputed
// rather than presenting a Skylane as a drone.
const MANNED_RE = /(CESSNA|PIPER|BEECH|CIRRUS|DIAMOND|MOONEY|ROBINSON|BELL|AIRBUS|BOEING|EMBRAER|BOMBARDIER|GULFSTREAM|LEARJET|SOCATA|PILATUS|TECNAM|MAULE|AVIAT|GRUMMAN|EXTRA|ROBIN|SLING|CIRRUS|QUEST|DAHER)/i;

// What kind of contact is this, why, and how much should we trust it?
// Returns null for ordinary civil traffic.
// Classification is INHERITED, never verified by us. Three independent sources, each with its
// own failure mode, and none of them constitutes proof:
//
//   registry_type  a third-party aircraft registry says this hex is an RQ-4, MQ-9, etc.
//                  Fails on stale records and reassigned hex codes.
//   self_declared  the aircraft itself broadcasts ADS-B emitter category B6 ("unmanned").
//                  Fails on misconfigured transponders — manned aircraft do broadcast B6.
//   database_flag  airplanes.live's curated database marks this hex as military.
//                  That is their editorial judgement; contractors and state aircraft blur it.
//
// And beneath all three: ADS-B IS UNAUTHENTICATED. It is a cooperative broadcast system with
// no signature and no verification — anyone with a transmitter can assert anything. We report
// what was broadcast and who says what about it. We never claim to have confirmed an identity,
// so the old "confirmed" label has been replaced with the actual basis.
function classify(a) {
  if (a.typeCode && UAV_TYPE_RE.test(a.typeCode))
    return { kind: "uav", why: `registry type ${a.typeCode}`, confidence: "registry_type" };
  if (a.category === "B6") {
    if (a.desc && MANNED_RE.test(a.desc))
      return { kind: "uav", why: `broadcasts UAV category, but registry says ${a.desc}`, confidence: "disputed" };
    return { kind: "uav", why: "aircraft broadcasts UAV category (B6)", confidence: "self_declared" };
  }
  if (a.military) return { kind: "military", why: "flagged military in aircraft database", confidence: "database_flag" };
  return null;
}

const SITE_INTERVAL_MS = Number(process.env.SWEEP_INTERVAL_MS || 15000); // one site per 15s → full cycle ≈ 7 min
const RADIUS_NM = 250;                 // upstream maximum
const RETAIN_MS = 24 * 60 * 60 * 1000; // keep sightings for 24h
const MAX_TRACKED = 3000;              // memory bound

// Publicly known UAV airspaces (mirrors the UAV Watch catalog entries).
const SITES = [

  // ---- Iran, North Korea and their approaches ----
  //
  // EXPECT SILENCE INSIDE BOTH. North Korea has virtually no ADS-B receivers, its military does
  // not broadcast, and civil traffic is minimal. Iran's civil fleet broadcasts but this watch only
  // archives military/UAV. So these airspaces will usually read empty, and empty here means
  // "not visible to public ADS-B", never "nothing happened" (the standing absence rule).
  //
  // The APPROACHES are where activity is actually observable: allied ISR and patrol aircraft
  // operating in international airspace nearby do frequently broadcast. Those sites are the ones
  // that will produce contacts, and they are what makes this coverage worth having.

  // Iran — internal (published international airports)
  ["Tehran Mehrabad", "Iran", 35.689, 51.313],
  ["Isfahan", "Iran", 32.750, 51.861],
  ["Bandar Abbas", "Iran", 27.218, 56.378],
  ["Bushehr", "Iran", 28.945, 50.835],
  ["Chabahar", "Iran", 25.443, 60.382],
  ["Mashhad", "Iran", 36.235, 59.641],
  ["Tabriz", "Iran", 38.134, 46.235],

  // Iran — approaches (international airspace and waters, where activity IS observable)
  ["Strait of Hormuz", "International", 26.567, 56.250],
  ["Persian Gulf central", "International", 27.000, 51.500],
  ["Gulf of Oman", "International", 24.500, 58.500],

  // North Korea — internal (published airports)
  ["Pyongyang Sunan", "North Korea", 39.224, 125.670],
  ["Wonsan Kalma", "North Korea", 39.166, 127.486],
  ["Chongjin", "North Korea", 41.771, 129.667],
  ["Sondok", "North Korea", 39.745, 127.474],

  // North Korea — approaches (where allied ISR is actually visible)
  ["Sea of Japan / East Sea", "International", 40.000, 132.000],
  ["Yellow Sea approach", "International", 37.500, 124.000],
  ["Korea Strait", "International", 34.500, 129.000],

  // ---- Russia, China and Central Asia ----
  //
  // Added for even-handed coverage: the watch should apply the same method everywhere rather
  // than only to NATO airspace. Every entry below is an internationally published airport or
  // region centre with an ICAO identifier, the same reference data any flight-planning tool
  // uses — nothing here is derived from imagery or private sources.
  //
  // IMPORTANT, and surfaced in the UI: expect these to read sparse or empty. Russian and
  // Chinese military aircraft very largely do not broadcast ADS-B, and the receiver network
  // inside both countries is thin because it is volunteer-fed. An empty airspace here means
  // "not visible to public ADS-B", NOT "no activity". Civil traffic is the main thing that
  // will appear.

  // Russia — west and Arctic
  ["Moscow region", "Russia", 55.750, 37.620],
  ["St Petersburg", "Russia", 59.800, 30.263],
  ["Kaliningrad", "Russia", 54.890, 20.593],
  ["Murmansk / Kola", "Russia", 68.782, 32.751],
  ["Arkhangelsk", "Russia", 64.600, 40.717],
  ["Voronezh", "Russia", 51.814, 39.230],
  ["Rostov-on-Don", "Russia", 47.258, 39.818],
  ["Volgograd", "Russia", 48.782, 44.345],
  ["Sochi / Black Sea", "Russia", 43.449, 39.957],
  ["Crimea region", "Russia/Ukraine (disputed)", 45.052, 34.100],
  ["Kazan", "Russia", 55.606, 49.279],
  ["Samara", "Russia", 53.505, 50.164],
  ["Yekaterinburg", "Russia", 56.743, 60.803],
  ["Rostov / Azov coast", "Russia", 47.100, 38.500],

  // Russia — Siberia and Far East
  ["Novosibirsk", "Russia", 55.013, 82.651],
  ["Krasnoyarsk", "Russia", 56.173, 92.493],
  ["Irkutsk / Baikal", "Russia", 52.268, 104.389],
  ["Yakutsk", "Russia", 62.093, 129.771],
  ["Khabarovsk", "Russia", 48.528, 135.188],
  ["Vladivostok / Primorye", "Russia", 43.399, 132.148],
  ["Yuzhno-Sakhalinsk", "Russia", 46.889, 142.718],
  ["Petropavlovsk-Kamchatsky", "Russia", 53.168, 158.454],
  ["Anadyr / Chukotka", "Russia", 64.735, 177.741],

  // China
  ["Beijing region", "China", 40.080, 116.585],
  ["Tianjin / Bohai", "China", 39.124, 117.346],
  ["Shenyang / Liaoning", "China", 41.640, 123.483],
  ["Dalian / Yellow Sea", "China", 38.966, 121.539],
  ["Qingdao / Shandong", "China", 36.266, 120.374],
  ["Shanghai region", "China", 31.197, 121.336],
  ["Fuzhou / Taiwan Strait", "China", 25.935, 119.663],
  ["Xiamen / Taiwan Strait", "China", 24.544, 118.128],
  ["Guangzhou / Pearl Delta", "China", 23.392, 113.299],
  ["Hong Kong", "China", 22.309, 113.915],
  ["Sanya / Hainan", "China", 18.303, 109.412],
  ["Kunming", "China", 25.102, 102.929],
  ["Chengdu", "China", 30.579, 103.947],
  ["Xi'an", "China", 34.447, 108.752],
  ["Lanzhou", "China", 36.515, 103.620],
  ["Urumqi / Xinjiang", "China", 43.907, 87.474],
  ["Kashgar", "China", 39.543, 76.020],
  ["Lhasa / Tibet", "China", 29.298, 90.912],
  ["Harbin", "China", 45.623, 126.250],

  // Central Asia, Caucasus and Caspian
  ["Astana", "Kazakhstan", 51.022, 71.467],
  ["Almaty", "Kazakhstan", 43.352, 77.041],
  ["Aktau / Caspian", "Kazakhstan", 43.860, 51.092],
  ["Bishkek", "Kyrgyzstan", 43.061, 74.478],
  ["Dushanbe", "Tajikistan", 38.543, 68.825],
  ["Samarkand", "Uzbekistan", 39.700, 66.984],
  ["Ashgabat", "Turkmenistan", 37.987, 58.361],
  ["Baku / Caspian", "Azerbaijan", 40.467, 50.047],
  ["Yerevan", "Armenia", 40.147, 44.396],
  ["Tbilisi", "Georgia", 41.669, 44.955],
  // ---- North America ----
  ["Creech / Nellis", "United States", 36.587, -115.673],
  ["Edwards AFB / Plant 42", "United States", 34.905, -117.884],
  ["China Lake NAWS", "United States", 35.688, -117.690],
  ["Yuma Proving Ground", "United States", 32.900, -114.400],
  ["Luke AFB / Phoenix", "United States", 33.535, -112.383],
  ["Fort Huachuca", "United States", 31.580, -110.340],
  ["Holloman AFB", "United States", 32.850, -106.110],
  ["White Sands Range", "United States", 32.380, -106.480],
  ["Cannon AFB", "United States", 34.380, -103.320],
  ["Beale AFB", "United States", 39.140, -121.440],
  ["Naval Base Ventura", "United States", 34.120, -119.120],
  ["Fort Bliss / El Paso", "United States", 31.850, -106.380],
  ["Corpus Christi NAS", "United States", 27.690, -97.290],
  ["Eglin AFB", "United States", 30.480, -86.520],
  ["Hurlburt Field", "United States", 30.430, -86.690],
  ["Robins AFB", "United States", 32.640, -83.590],
  ["Cherry Point MCAS", "United States", 34.900, -76.880],
  ["Norfolk / Oceana", "United States", 36.820, -76.030],
  ["Dover AFB", "United States", 39.130, -75.470],
  ["Wright-Patterson AFB", "United States", 39.830, -84.050],
  ["Offutt AFB", "United States", 41.120, -95.910],
  ["Tinker AFB", "United States", 35.410, -97.390],
  ["Grand Forks AFB", "United States", 47.960, -97.400],
  ["Eielson AFB", "United States", 64.670, -147.100],
  ["JB Elmendorf-Richardson", "United States", 61.250, -149.810],
  ["JB Pearl Harbor-Hickam", "United States", 21.330, -157.920],
  ["CFB Cold Lake", "Canada", 54.400, -110.280],
  ["CFB Goose Bay", "Canada", 53.320, -60.420],
  ["CFB Comox", "Canada", 49.710, -124.890],

  // ---- Europe ----
  ["RAF Waddington", "United Kingdom", 53.170, -0.520],
  ["RAF Lakenheath / Mildenhall", "United Kingdom", 52.410, 0.560],
  ["RAF Fairford", "United Kingdom", 51.680, -1.790],
  ["RAF Lossiemouth", "United Kingdom", 57.710, -3.340],
  ["RAF Brize Norton", "United Kingdom", 51.750, -1.580],
  ["Ramstein AB", "Germany", 49.440, 7.600],
  ["Spangdahlem AB", "Germany", 49.970, 6.690],
  ["Leeuwarden AB", "Netherlands", 53.220, 5.760],
  ["Kleine Brogel AB", "Belgium", 51.170, 5.470],
  ["Istres-Le Tube", "France", 43.520, 4.920],
  ["Aviano AB", "Italy", 46.030, 12.600],
  ["Sigonella NAS", "Italy", 37.400, 14.920],
  ["Decimomannu AB", "Italy", 39.350, 8.970],
  ["Rota NS", "Spain", 36.650, -6.350],
  ["Moron AB", "Spain", 37.170, -5.620],
  ["Beja AB", "Portugal", 38.080, -7.930],
  ["Keflavik", "Iceland", 63.990, -22.610],
  ["Orland AS", "Norway", 63.700, 9.600],
  ["Evenes", "Norway", 68.490, 16.680],
  ["Lulea-Kallax", "Sweden", 65.540, 22.120],
  ["Rovaniemi", "Finland", 66.560, 25.830],
  ["Amari AB", "Estonia", 59.260, 24.210],
  ["Siauliai AB", "Lithuania", 55.890, 23.390],
  ["Miroslawiec", "Poland", 53.400, 16.080],
  ["Powidz AB", "Poland", 52.380, 17.850],
  ["Mihail Kogalniceanu", "Romania", 44.360, 28.490],
  ["Graf Ignatievo", "Bulgaria", 42.290, 24.710],
  ["Larissa AB", "Greece", 39.650, 22.460],
  ["Souda Bay", "Greece", 35.530, 24.150],
  ["RAF Akrotiri", "Cyprus", 34.590, 32.990],

  // ---- Middle East ----
  ["Incirlik AB", "Turkiye", 37.000, 35.430],
  ["Al Udeid AB", "Qatar", 25.120, 51.320],
  ["Al Dhafra AB", "UAE", 24.250, 54.550],
  ["Ali Al Salem AB", "Kuwait", 29.350, 47.520],
  ["Prince Sultan AB", "Saudi Arabia", 24.060, 47.580],
  ["Muwaffaq Salti AB", "Jordan", 31.830, 36.780],
  ["Isa AB", "Bahrain", 25.920, 50.590],
  ["Palmachim AB", "Israel", 31.900, 34.690],
  ["Nevatim AB", "Israel", 31.210, 35.010],
  ["Erbil", "Iraq", 36.240, 43.960],
  ["Ain al-Asad", "Iraq", 33.790, 42.440],
  ["Bagram area", "Afghanistan", 34.950, 69.260],

  // ---- Africa ----
  ["Chabelley Airfield", "Djibouti", 11.520, 42.920],
  ["Air Base 201", "Niger", 16.970, 8.000],
  ["Manda Bay", "Kenya", -2.250, 40.910],
  ["Baledogle", "Somalia", 2.620, 44.860],
  ["Cairo West", "Egypt", 30.120, 30.920],
  ["Benghazi coast", "Libya", 32.100, 20.270],

  // ---- Asia ----
  ["Kadena AB", "Japan", 26.350, 127.770],
  ["Misawa AB", "Japan", 40.700, 141.370],
  ["Yokota AB", "Japan", 35.750, 139.350],
  ["Iwakuni MCAS", "Japan", 34.140, 132.240],
  ["Osan AB", "South Korea", 37.090, 127.030],
  ["Kunsan AB", "South Korea", 35.900, 126.620],
  ["Andersen AFB", "Guam", 13.580, 144.920],
  ["Clark AB", "Philippines", 15.190, 120.550],
  ["U-Tapao", "Thailand", 12.680, 101.000],
  ["Diego Garcia", "BIOT", -7.310, 72.410],
  ["Jamnagar AFS", "India", 22.470, 70.010],
  ["Chabua AFS", "India", 27.460, 95.120],
  ["Hindon AFS", "India", 28.710, 77.350],
  ["Nur Khan AB", "Pakistan", 33.620, 73.100],

  // ---- Oceania & South America ----
  ["Woomera Range", "Australia", -31.140, 136.800],
  ["RAAF Tindal", "Australia", -14.520, 132.380],
  ["RAAF Amberley", "Australia", -27.640, 152.710],
  ["RAAF Edinburgh", "Australia", -34.700, 138.620],
  ["RNZAF Ohakea", "New Zealand", -40.210, 175.390],
  ["Palanquero", "Colombia", 5.480, -74.660],
  ["Comalapa", "El Salvador", 13.440, -89.060],
  ["Hato / Curacao", "Curacao", 12.190, -68.960],
  // ---- Conflict-adjacent airspaces ----
  // NOTE: aircraft engaged in combat generally fly with transponders off. What is visible
  // here is the surrounding logistics and surveillance traffic operating from nearby bases,
  // plus civil aviation. Presence of a site is not a claim about who is fighting whom.
  ["Rzeszow / Ukraine border", "Poland", 50.110, 22.020],
  ["Iasi / Ukraine border", "Romania", 47.180, 27.620],
  ["Chisinau approach", "Moldova", 46.930, 28.930],
  ["Black Sea south", "International waters", 43.500, 32.000],
  ["Beirut / Levant coast", "Lebanon", 33.820, 35.490],
  ["Golan / north Israel", "Israel", 33.100, 35.600],
  ["Red Sea north", "International waters", 20.500, 38.500],
  ["Bab-el-Mandeb", "International waters", 12.600, 43.400],
  ["Port Sudan", "Sudan", 19.580, 37.220],
  ["Bamako / Sahel", "Mali", 12.530, -7.950],
  ["Lake Chad basin", "Chad", 13.100, 14.500],
  ["Goma / Great Lakes", "DR Congo", -1.670, 29.240],
  ["Yerevan / Caucasus", "Armenia", 40.150, 44.400],
  ["Taiwan Strait", "International waters", 24.500, 119.500],
  ["South China Sea north", "International waters", 16.500, 114.000],
  ["Korea DMZ approach", "South Korea", 37.900, 126.900],
  ["Kashmir / Srinagar", "India", 34.000, 74.780],
  ["Caribbean south", "International waters", 12.800, -70.500],

  // ---- Extended global coverage: every country with plausibly observable military or
  //      state aviation. Many of these will stay quiet for long periods — that is expected,
  //      and the cold tier means quiet sites cost almost nothing.
  ["Baldonnel", "Ireland", 53.300, -6.440],
  ["Karup AB", "Denmark", 56.300, 9.120],
  ["Lielvarde AB", "Latvia", 56.780, 24.850],
  ["Machulishchy", "Belarus", 53.770, 27.630],
  ["Lviv approach", "Ukraine", 49.810, 23.960],
  ["Zeltweg AB", "Austria", 47.200, 14.740],
  ["Payerne AB", "Switzerland", 46.840, 6.920],
  ["Caslav AB", "Czechia", 49.940, 15.380],
  ["Sliac AB", "Slovakia", 48.640, 19.130],
  ["Kecskemet AB", "Hungary", 46.920, 19.750],
  ["Cerklje AB", "Slovenia", 45.900, 15.530],
  ["Zagreb Pleso", "Croatia", 45.740, 16.070],
  ["Batajnica AB", "Serbia", 44.930, 20.260],
  ["Sarajevo", "Bosnia", 43.820, 18.330],
  ["Skopje", "North Macedonia", 41.960, 21.620],
  ["Kucove AB", "Albania", 40.780, 19.900],
  ["Podgorica", "Montenegro", 42.360, 19.250],
  ["Luqa", "Malta", 35.860, 14.480],
  ["Findel", "Luxembourg", 49.630, 6.210],
  ["Tampere-Pirkkala", "Finland", 61.410, 23.600],
  ["Bodo", "Norway", 67.270, 14.370],
  ["Kaliningrad", "Russia", 54.890, 20.590],
  ["Moscow area", "Russia", 55.570, 37.270],
  ["Vladivostok", "Russia", 43.400, 132.150],
  ["Thumrait AB", "Oman", 17.670, 54.020],
  ["Aden", "Yemen", 12.830, 45.030],
  ["Latakia", "Syria", 35.400, 35.950],
  ["Tehran area", "Iran", 35.420, 51.150],
  ["Kenitra AB", "Morocco", 34.300, -6.600],
  ["Boufarik AB", "Algeria", 36.550, 2.870],
  ["Bizerte", "Tunisia", 37.240, 9.790],
  ["Addis Ababa", "Ethiopia", 8.980, 38.800],
  ["Asmara", "Eritrea", 15.290, 38.910],
  ["Entebbe", "Uganda", 0.040, 32.440],
  ["Dar es Salaam", "Tanzania", -6.870, 39.200],
  ["Kigali", "Rwanda", -1.970, 30.140],
  ["Brazzaville", "Congo", -4.250, 15.250],
  ["Libreville", "Gabon", 0.460, 9.410],
  ["Yaounde", "Cameroon", 3.720, 11.550],
  ["Abuja", "Nigeria", 9.010, 7.270],
  ["Ouagadougou", "Burkina Faso", 12.350, -1.510],
  ["Dakar", "Senegal", 14.740, -17.490],
  ["Nouakchott", "Mauritania", 18.100, -15.950],
  ["Accra", "Ghana", 5.600, -0.170],
  ["Abidjan", "Cote d'Ivoire", 5.260, -3.930],
  ["Bangui", "Central African Rep", 4.400, 18.520],
  ["Juba", "South Sudan", 4.870, 31.600],
  ["Lusaka", "Zambia", -15.330, 28.450],
  ["Harare", "Zimbabwe", -17.930, 31.090],
  ["Gaborone", "Botswana", -24.550, 25.920],
  ["Windhoek", "Namibia", -22.480, 17.470],
  ["Waterkloof AFB", "South Africa", -25.830, 28.220],
  ["Maputo", "Mozambique", -25.920, 32.570],
  ["Luanda", "Angola", -8.860, 13.230],
  ["Antananarivo", "Madagascar", -18.800, 47.480],
  ["Conakry", "Guinea", 9.580, -13.610],
  ["Monrovia", "Liberia", 6.240, -10.360],
  ["Lome", "Togo", 6.170, 1.250],
  ["Cotonou", "Benin", 6.360, 2.380],
  ["Lilongwe", "Malawi", -13.790, 33.780],
  ["Hanoi area", "Vietnam", 21.220, 105.810],
  ["Phnom Penh", "Cambodia", 11.550, 104.840],
  ["Vientiane", "Laos", 17.990, 102.560],
  ["Yangon", "Myanmar", 16.900, 96.130],
  ["Butterworth AB", "Malaysia", 5.470, 100.390],
  ["Paya Lebar AB", "Singapore", 1.360, 103.910],
  ["Jakarta area", "Indonesia", -6.130, 106.660],
  ["Brunei", "Brunei", 4.940, 114.930],
  ["Beijing area", "China", 39.510, 116.410],
  ["Ulaanbaatar", "Mongolia", 47.840, 106.770],
  ["Almaty", "Kazakhstan", 43.350, 77.040],
  ["Tashkent", "Uzbekistan", 41.260, 69.270],
  ["Ashgabat", "Turkmenistan", 37.990, 58.360],
  ["Dushanbe", "Tajikistan", 38.540, 68.820],
  ["Bishkek", "Kyrgyzstan", 43.060, 74.480],
  ["Baku", "Azerbaijan", 40.470, 50.050],
  ["Tbilisi", "Georgia", 41.670, 44.950],
  ["Kathmandu", "Nepal", 27.700, 85.360],
  ["Dhaka", "Bangladesh", 23.840, 90.400],
  ["Colombo", "Sri Lanka", 7.180, 79.880],
  ["Male", "Maldives", 4.190, 73.530],
  ["Dili", "Timor-Leste", -8.550, 125.520],
  ["Santa Lucia AB", "Mexico", 19.750, -99.020],
  ["Guatemala City", "Guatemala", 14.580, -90.530],
  ["Soto Cano AB", "Honduras", 14.380, -87.620],
  ["Managua", "Nicaragua", 12.140, -86.170],
  ["San Jose", "Costa Rica", 9.990, -84.210],
  ["Panama City", "Panama", 8.910, -79.600],
  ["Havana", "Cuba", 23.000, -82.410],
  ["Santo Domingo", "Dominican Rep", 18.430, -69.670],
  ["Port-au-Prince", "Haiti", 18.580, -72.290],
  ["Kingston", "Jamaica", 17.940, -76.790],
  ["Port of Spain", "Trinidad", 10.600, -61.340],
  ["Caracas", "Venezuela", 10.600, -66.990],
  ["Quito", "Ecuador", -0.140, -78.490],
  ["Lima area", "Peru", -12.020, -77.110],
  ["La Paz", "Bolivia", -16.510, -68.190],
  ["Brasilia", "Brazil", -15.870, -47.920],
  ["Manaus", "Brazil", -3.040, -60.050],
  ["Rio de Janeiro", "Brazil", -22.910, -43.160],
  ["Asuncion", "Paraguay", -25.240, -57.520],
  ["Montevideo", "Uruguay", -34.790, -56.030],
  ["Buenos Aires", "Argentina", -34.560, -58.420],
  ["Rio Gallegos", "Argentina", -51.610, -69.310],
  ["Santiago", "Chile", -33.390, -70.790],
  ["Punta Arenas", "Chile", -53.000, -70.850],
  ["Georgetown", "Guyana", 6.800, -58.250],
  ["Paramaribo", "Suriname", 5.450, -55.190],
  ["Belize City", "Belize", 17.540, -88.310],
  ["Nassau", "Bahamas", 25.040, -77.470],
  ["Pituffik", "Greenland", 76.530, -68.700],
  ["CFB Trenton", "Canada", 44.120, -77.530],
  ["CFB Bagotville", "Canada", 48.330, -70.990],
  ["Port Moresby", "Papua New Guinea", -9.440, 147.220],
  ["Nadi", "Fiji", -17.750, 177.440],
  ["Noumea", "New Caledonia", -22.010, 166.210],
  ["Kwajalein", "Marshall Islands", 8.720, 167.730],
  ["Tahiti Faa'a", "French Polynesia", -17.550, -149.610],
  ["RAAF Darwin", "Australia", -12.410, 130.880],
  ["RAAF Pearce", "Australia", -31.670, 116.020],
  ["Honiara", "Solomon Islands", -9.430, 160.050],
  ["Guadalcanal approach", "Vanuatu", -17.700, 168.320],
  ["McMurdo approach", "Antarctica", -77.850, 166.670],
];

const seen = new Map();     // id -> sighting record


// Deep sweep: a coarse global grid derived from where feeds actually exist (airports,
// ports, webcams), so it follows land and coastline without needing a geo library.
// These are unnamed cells on a very slow rotation — they exist to catch traffic the
// curated watch list would never see. A cell that produces a contact is promoted into
// the normal hot/warm rotation like any other site.
const DEEP_GRID = [
  [16.72,79.35], [16.62,74.7], [12.93,79.25], [22.54,88.36], [21.17,71.94], [25.91,75.64], [29.61,76.51], [9.63,76.46],
  [25.91,79.97], [17.88,73.36], [28.92,79.44], [12.38,76.45], [21.33,79.48], [-12.24,-76.26], [9.07,-75.25], [-33.68,-59.1],
  [-21.69,-42.61], [7.94,80.11], [25.28,67.33], [21.52,92.01], [25.31,55.19], [25.99,50.65], [17.12,54.04], [-29.25,29.87],
  [-4.64,38.42], [36.64,-4.94], [30.53,30.61], [4.14,100.97], [-4.96,105.71], [13.3,100.6], [-12.7,-71.32], [-33.57,-71.12],
  [27.88,84.35], [33.43,34.44], [30.18,33.6], [33.13,-7.51], [-17.64,25.36], [50.56,4.21], [42.26,12.86], [-33.8,150.75],
  [38,-121.43], [22.61,113.56], [1.19,103.88], [-0.74,-90.31], [-11.8,-67.06], [25.48,92.42], [33.81,-117.65], [-23.61,-46.38],
  [4.49,-75.48], [24.57,46.44], [41.39,28.71], [42.18,-71.67], [54.32,8.99], [38.06,25.56], [41.33,-75.02], [33.75,130.46],
  [35.12,138.72], [-3.61,-59.39], [-16.86,145.83], [18.33,-66.87], [46.21,8.56], [51.02,0.05], [43.03,3.93], [50.08,12.54],
  [25.77,-80.05], [21.5,-158.32], [42.33,-79.91], [42.03,17.04], [64.05,-21.77], [36.78,-113.99], [58.79,-156.18], [-0.66,36.82],
  [42.08,-92.22], [-20.63,16.74], [29.52,-96.66], [29.25,-81.18], [33.94,-113.25], [41.81,-83.66], [46.47,-122.51], [38.9,-105.42],
  [41.64,-112.61], [42.45,-117.05], [61.74,-149.74], [49.3,-122.85], [54.51,-3.81], [55.09,12.52], [8.8,-80], [24.7,-76.33],
  [3.66,20.56], [45.82,12.53], [-33.33,18.37], [-25.36,32.35], [29.92,104.73], [30.26,121.23], [58.98,25.12], [37.87,121.22],
  [42.24,130.33], [59.22,29.79], [46.14,38.38], [21.04,105.89], [12.81,121.88], [55.01,37.83], [51.2,104.61], [37.71,126.78],
  [43.06,75.92], [24.4,-82.23], [18.17,-76.3], [45.96,28.86], [54.5,16.76], [58.73,12.1], [29.71,47.46], [4.18,73.51],
  [13.24,-16.48], [-8.87,13.3], [-20.24,57.55], [-3.71,-80.11], [20.42,-97.19], [-17.91,177.93], [-8.35,147.04], [-37.69,175.79],
  [30.53,-88.08], [33.99,-79.9], [38.32,-76.27], [45.75,-92.77], [45.1,-75.23], [45.89,-63.53], [54.58,-130.82], [20.02,-104.31],
  [-25.43,-49.52], [-31.92,-52.21], [-12.37,-38.26], [-4.47,-38.15], [-34.31,-56.01], [-21.71,-70.24], [-53,-70.61], [10.98,-74.54],
  [9.72,-67.56], [6.74,-58.18], [37.98,-0.33], [42.3,-4.06], [38.5,-8.35], [38.12,15.81], [55.04,20.78], [41.88,20.62],
  [36.95,13.02], [59.65,5.4], [24.94,118.35], [38.45,117.48], [22.31,120.78], [34.51,134.09], [17.46,82.93], [16.79,96.77],
  [11.46,105.03], [-7.8,113.07], [8.3,125.04], [25.73,63.07], [13.3,45.12], [20.85,38.44], [6.79,3.66], [5.64,0.01],
  [5.25,-3.98], [4.77,8.42], [-5.37,12.4], [-22.16,14.5], [-28.39,32.07], [-7.12,38.09], [12.35,43.01], [37.65,3.93],
  [-16.87,49.69], [34.21,62.23], [33.67,68.11], [37.98,68.2], [25.38,9.41], [37.32,8.97], [34.81,-0.64], [33.15,4.59],
  [-14.07,-171.31], [17.43,-62.96], [-28.86,-64.48], [-32.99,-67.08], [-25.85,-65.3], [-29.19,-58.27], [-23.77,-64.71], [-46.69,-67.21],
  [-51.32,-71.6], [-38.43,-68.77], [-41.74,-72.38], [41.78,42.14], [41.69,45.74], [11.57,-70.89], [-29.56,151.77], [-28.5,153.53],
  [-17.63,123.24], [-25.08,151.59], [-37.25,142.99], [-41.62,146.6], [-34.06,138.26], [-12.3,130.54], [-20.96,117.72], [-32.85,116.8],
  [46.67,16.74], [40.94,50.03], [38.6,45.38], [12.31,-60.05], [50.48,24.92], [54.17,29.65], [16.75,-87.98], [32.34,-64.71],
  [27.97,88.23], [-20,-66.18], [-17.3,-67.15], [-16.89,-63.09], [-20.5,28.67], [-20.26,24.77], [-25.8,26.23], [-1.08,-49.2],
  [-17.38,-48.07], [3.8,-59.99], [-16.12,-55.42], [-25.83,-54.53], [-28.75,-50.43], [-16.24,-50.19], [-7.66,-34.91], [-21.65,-46.81],
  [-8.96,-36.41], [-15.93,-39.1], [-5.33,-34.56], [-4.06,-45.85], [4.18,114.15], [41.88,25.32], [12.36,-1.51], [13.03,-5.18],
  [-3.45,29.25], [9.34,12.9], [4.4,11.28], [54.05,-113.95], [50.26,-118.38], [45.81,-72.04], [49.92,-96.76], [50.86,-105.31],
  [50.19,-113.72], [47.18,-54.46], [16.59,-22.94], [15.89,-24.09], [11.85,-68.13], [21.07,-80.34], [4.34,17.61], [12.13,15.03],
  [-25.77,-70.49], [-37.67,-72.72], [-27.16,-109.42], [40.84,117.27], [37.56,109.53], [41.11,112.84], [40.74,109.66], [38.12,113.31],
  [34.02,109.21], [29.14,108.96], [24.66,113.36], [29.68,113.3], [24.95,109.34], [21.27,109.45], [33.79,113.41], [17.47,108.88],
  [37.56,105.43], [37.8,96.8], [37.96,101.17], [20.75,100.42], [25.22,100.71], [25.45,104.77], [29.4,117.49], [33.63,118.08],
  [32.29,120.42], [28.73,93.03], [37.84,75.67], [43.01,87.82], [42.16,125.64], [45.76,125.4], [41.24,121.91], [-12.19,96.83],
  [12.97,-81.53], [-12.61,41.82], [-21.2,-159.81], [11.42,-84.51], [9.51,-83.6], [7.85,-4.58], [20.98,-75.45], [22.48,-82.79],
  [50.27,16.74], [-4.28,16.27], [-1.2,29.83], [-12.61,28.15], [58.8,9.13], [18.41,-70.81], [20.6,-71.7], [-0.11,-79.48],
  [25.45,33.52], [13.25,-87.94], [0.31,8.77], [8.19,38.12], [9.49,42.95], [-51.78,-58.25], [62.05,-7.11], [-17.26,178.95],
  [67.3,28.32], [66.77,24.86], [62.47,28.59], [63.39,24.86], [59.28,22.13], [63.01,21.39], [46.11,-0.22], [42.28,-0.11],
  [42.73,8.83], [46.06,4.39], [50.44,-3.35], [50.43,8.13], [4.53,-52.15], [-17.05,-150.63], [8.15,-0.21], [34.93,25.17],
  [38.58,21.31], [38.26,29.63], [64.19,-51.68], [12.71,-61.57], [13.47,144.8], [14.36,-90.97], [8.52,-12.52], [46.53,20.48],
  [65.91,-17.06], [20.7,75.65], [24.83,88.18], [25.84,84.49], [21.52,83.82], [32.92,75.22], [-5.09,119.5], [-8.65,117.48],
  [-7.29,109.61], [-4.18,138.97], [-0.97,116.95], [1.17,125.65], [-2.98,114.63], [-3.43,127.53], [0.22,109.89], [0.55,101.13],
  [4.21,97.46], [29.59,50.07], [33.72,50.33], [37.13,49.78], [29.36,57.69], [33.28,58.09], [37.31,58.24], [28.59,54.23],
  [30.29,61.22], [33.91,45.33], [37.34,42.13], [52.01,-8.2], [54.01,-7.82], [18.49,-77.9], [37.15,139.2], [42.42,142.26],
  [36.24,135.32], [41,140.16], [38.19,141.02], [25.7,126.51], [33.51,37.07], [50.35,72.4], [54.15,71.45], [55.13,67.3],
  [41.04,71.24], [41.18,67.85], [46.21,66.66], [45.84,63.23], [51,84.17], [51.89,76.14], [50.21,79.82], [50.66,57.9],
  [54.83,62.1], [0.28,33.8], [1.36,173.09], [16.35,104.56], [17.06,100.87], [5.4,-8.61], [31.06,16.6], [32.33,20.8],
  [33.72,12.19], [54.84,24.56], [-16.36,46.53], [-13.38,49.45], [-16.13,34.16], [-12.86,33.83], [4.75,117.51], [7.69,100.16],
  [4.64,73.15], [-0.1,73.08], [12.57,-7.97], [7.08,171.31], [17.1,-16.37], [20.94,-17.03], [-12.94,45.79], [17.61,-100.51],
  [20.46,-100.56], [16.56,-95.82], [24.66,-109.14], [33.37,-105.27], [29.81,-104.44], [20.79,-87.94], [29.28,-110.22], [25.57,-100.34],
  [24.28,-104.73], [16.79,-92.3], [7.46,151.84], [47.71,106.8], [29.75,-8.83], [34.2,-3.91], [-20.65,34.35], [-16.94,37.69],
  [20.99,96.81], [-21.46,167.17], [-42.76,172.15], [-45.58,168.61], [-40.58,175.2], [13.09,3.49], [8.83,8.09], [12.33,7.71],
  [13.98,145.14], [62.06,5.6], [66.76,13.71], [68.37,16.06], [69.71,19.62], [62.84,12.34], [20.81,58.75], [24.49,58.86],
  [29.93,71.48], [33.47,71.78], [28.35,67.78], [7.37,134.54], [-25.47,-57.74], [-7.94,-76.5], [-7.96,-79.03], [-17.5,-70.86],
  [-3.98,-71.39], [16.6,120.91], [5.49,125.25], [8.02,123.07], [50.8,20.63], [32.78,-16.69], [38.19,-26.45], [41.65,-8.41],
  [-20.96,55.47], [46.15,25.18], [62.1,129.66], [53.73,158.3], [46.11,142.39], [51.71,114.06], [51.69,108.36], [68.76,33.29],
  [55.59,91.75], [54.96,83.59], [54.54,86.49], [69.34,86.74], [45.27,41.83], [46.35,46.74], [50.39,46.08], [62.11,75.43],
  [57.38,54.74], [61.22,73.03], [56.72,60.8], [57.62,66.84], [57.73,40.61], [54.58,42.06], [54.24,50.33], [54.76,46.5],
  [54.6,54.34], [16.6,42.78], [25.4,37.89], [29.44,41.6], [30.04,36.68], [20.8,41.2], [-4.59,55.54], [-9.43,160.03],
  [12.94,49.2], [2.03,45.31], [-28.56,24.82], [-32.3,28.47], [-33.81,21.49], [-25.53,29.27], [-33.4,25.72], [34.76,127.16],
  [36.54,128.79], [3.98,33.09], [28.66,-13.2], [28.27,-16.66], [16.62,32.3], [4.69,-54.93], [59.01,16.66], [66.52,20.64],
  [37.29,37.73], [24.92,120.92], [37.43,70.24], [9.31,98.48], [-8.82,125.41], [-20.85,-174.96], [40.73,33.17], [37.68,34.19],
  [41.94,60.03], [37.74,62.93], [45.97,33.89], [53.73,-0.66], [57.98,-3.08], [33.8,-84.07], [33.92,-88.25], [38.02,-88.19],
  [38.19,-84.39], [33.44,-96.94], [46.57,-117.74], [37.69,-79.72], [38,-96.19], [41.9,-87.98], [41.78,-96.82], [29.36,-83.66],
  [37.26,-92.67], [33.2,-109.43], [20.51,-156.24], [-16.79,167.82], [9.18,-63.02], [8.19,-71.44], [12.5,108.59], [9.75,105.62],
  [-13.24,-176.2], [23.72,-15.93], [26.94,-12.45], [16.85,45.25], [16.08,50.48], [-16.4,29.35], [33.62,8.94], [28.54,0.05],
  [26.82,3.92], [29.1,9.67], [-11.87,13.61], [-8.54,20.63], [-17.23,15.53], [-13.29,16.81], [-8.29,15.54], [-15.13,12.63],
  [-29.44,-66.28], [-33.7,-63.75], [-29.48,-54.99], [-21.97,-63.71], [-42.98,-65.19], [-41.47,-64.25], [-54.28,-67.95], [-50.32,-68.53],
  [-46.03,-72.17], [-37.47,-62.65], [-37.8,-58.25], [-15.68,129.59], [-24.69,147.13], [-25.12,139.4], [-34.15,143.1], [-20.84,147.9],
  [-29.59,147.3], [-37.12,146.56], [-21.42,139.96], [-21.24,149.24], [-12.18,142.4], [-25.39,113.62], [-33.76,147.46], [-28.97,135.53],
  [-33.37,134.8], [-13.14,134.66], [-18.21,126.62], [-16.58,141.41], [-30.13,138.25], [-29.17,121.16], [-25.15,143.73], [-24.89,118.15],
  [-36.4,150.02], [-25.78,120.19], [-29.79,116.97], [-28.72,142.94], [-20.45,-58.4], [-16.34,-41.89], [-9.32,-48.83], [-21.7,-49.82],
  [-9.6,-55.54], [-22.07,-55.71], [-7.27,-47.85], [-4.63,-50.28], [-7.88,-71.78], [-3.04,-55.16], [-3.62,-41.29], [-13.08,-48.04],
  [-1.19,-54.5], [-4.6,-63], [-7.31,72.41], [50.23,-125.24], [49.53,-92.88], [46.27,-84.05], [50.16,-55.33], [49.01,-67.95],
  [54.26,-109.85], [48.53,-71.82], [50.45,-101], [53.9,-104.98], [49.87,-57.94], [46.36,-66.79], [49.46,-79.81], [54.98,-121.81],
  [62.71,-139.08], [62.6,-133.89], [45.86,-79.93], [54.78,-117.15], [61.82,-114.06], [62.48,-122.34], [54.45,-77.73], [49.88,-63.4],
  [49.6,-88.24], [49.35,-84.19], [60.15,-138.6], [59.32,-117.45], [55.19,-96.99], [59.54,-123.03], [58.26,-105.18], [53.86,-66.83],
  [50.09,-109.34], [55.24,-100.54], [54.6,-126.57], [43.94,-67.59], [62.69,-141.4], [58.4,-134.54], [18.22,19.65], [13.28,21.4],
  [-29.38,-71.18], [32.96,105.28], [43.23,93.2], [28.56,100.88], [46.89,121.9], [50,117.25], [33.92,101.76], [25.02,97.92],
  [28.39,96.09], [42.58,80.01], [47.59,88.2], [49.85,126.24], [46.54,133.19], [46.1,130.06], [-10.45,105.69], [0.59,-76.58],
  [5.3,-67.92], [4.83,-72.56], [7.03,-7.03], [-0.03,16.54], [2.94,29.25], [-4.52,24.74], [-11.51,25.48], [0.07,12.2],
  [15.45,38.59], [5.89,37.08], [12.94,38.27], [9.24,33.6], [9.18,44.73], [47.61,-2.95], [-15.5,-146.82], [-16.83,-141.83],
  [-14.44,-145.78], [-9.28,-139.62], [67.84,-53.26], [68.13,-50.89], [16.13,-85.94], [65.85,-23.34], [25.11,71.13], [8.08,93.37],
  [-3.74,134.16], [0.13,111.9], [-1.3,135.41], [0.58,129.81], [-4.27,121.69], [-1.12,121.11], [37.74,53.93], [34.04,41.96],
  [29.48,130.1], [26.28,130.33], [46.52,79.45], [-2.74,40.51], [-0.24,41.6], [-20.85,46.23], [-25.07,46.95], [-23.37,43.71],
  [-9.44,33.58], [4.03,103.47], [13.6,-12.42], [21.63,-12.76], [29.35,-100.19], [26.01,-97.83], [6.92,158.24], [46.21,101.75],
  [47.4,113.97], [50.87,93.17], [13.27,98.41], [-26.12,16.61], [-29.16,17.37], [-0.55,166.92], [52.93,5.1], [-20.92,165.05],
  [-44.97,170.78], [-35.16,173.6], [-39.03,174.1], [16.96,8.01], [5.37,5.94], [-19.08,-169.92], [-29.04,167.94], [15.1,145.7],
  [70.43,24.5], [70.44,29.56], [63.02,8.3], [-8.21,143.65], [-5.63,145.48], [-4.15,151.44], [-4.78,143.36], [-5.98,-76.64],
  [-15.54,-74.29], [5.55,120.38], [11.91,124.77], [38.8,-28.85], [50.99,42.02], [67.03,75.81], [54.43,33.47], [58.35,37.96],
  [43.23,133.27], [62.17,63.92], [51.15,37.51], [67.48,64.15], [63.82,122.23], [66.18,111.79], [49.79,138.56], [63.94,-171.82],
  [61.88,159.89], [59.7,150.82], [56.31,104.03], [64.53,40.57], [61.86,34.23], [58.74,47.08], [59.42,92.56], [67.14,87.51],
  [62.28,67.13], [64.3,53.89], [65.73,58.2], [-7.97,-14.39], [15.22,-12.9], [-8.28,157.23], [-28.02,22.13], [6.14,80.72],
  [12.83,25.14], [63.33,17.55], [40.97,37.81], [-8.52,179.2], [49.62,32.99], [50.1,29.83], [58.23,-1.81], [57.57,-7.05],
  [58.55,-158.37], [33.72,-100.48], [46.41,-96.86], [41.74,-124.18], [30.52,-92.72], [41.39,-100.73], [45.39,-88.45], [33.92,-92.7],
  [41.73,-104.42], [37.52,-117.75], [45.59,-109.96], [46.65,-100.74], [42.22,-109.08], [46.42,-112.76], [38.13,-108.3], [37.7,-100.77],
  [35.09,-77.22], [46.57,-105.16], [45.78,-124], [41.5,-122.42], [34.99,-120.43], [63.47,-147.27], [59.48,-161.91], [70.88,-157.1],
  [61.8,-166.07], [66.48,-162.68], [59.63,-151.09], [54.79,-167.58], [63.65,-164.97], [67.04,-159.15], [63.28,-155.91], [62.58,-160.08],
  [65.85,-155.03], [56.03,-132.72], [67.06,-166.48], [67.34,-145.41], [28.2,-177.38], [5.39,-62], [-42.45,-73.72],
];
const DEEP_SITES = DEEP_GRID.map(([lat, lon]) => [
  `Deep sweep ${Math.abs(lat).toFixed(1)}${lat >= 0 ? 'N' : 'S'} ${Math.abs(lon).toFixed(1)}${lon >= 0 ? 'E' : 'W'}`,
  'Deep sweep', lat, lon, true,
]);
const SWEEP_DEEP = process.env.SWEEP_DEEP !== '0';          // on unless disabled
const DEEP_EVERY = Number(process.env.SWEEP_DEEP_EVERY || 45);
const MAX_PASS = Number(process.env.SWEEP_MAX_PASS || 60);   // keeps hot refresh under ~15 min
if (SWEEP_DEEP) SITES.push(...DEEP_SITES);

// Adaptive rotation. With ~100 airspaces a plain round-robin at 15s would revisit each
// one only every ~25 min. Instead: any site that produced a contact in the last 24h is
// "hot" and gets visited every pass; quiet sites are checked once every COLD_EVERY passes.
// Upstream load is unchanged either way — it depends on the interval, not the site count.
// Three tiers, because breadth would otherwise cost freshness. With ~250 airspaces a
// two-tier scheme pushes the productive ones to a ~22 min refresh; tiering keeps them at ~11.
//   HOT   contact within 24h  -> every pass
//   WARM  contact within 30d  -> every WARM_EVERY passes
//   COLD  never seen anything -> every COLD_EVERY passes
const WARM_EVERY = Number(process.env.SWEEP_WARM_EVERY || 3);
const COLD_EVERY = Number(process.env.SWEEP_COLD_EVERY || 10);
// "Hot" should mean ACTIVE, not "saw something yesterday". Hot sites are polled every
// pass, so hot count sets the floor on the whole pass duration: 87 hot sites forced a
// 22-minute refresh no matter what the cap said. A 6h window keeps that set meaningful
// and lets the cap do its job; sites seen 6-24h ago fall to warm and are still revisited
// every ~3 passes, so nothing is forgotten — it is just polled at a rate matching its
// actual activity.
const HOT_MS = Number(process.env.SWEEP_HOT_HOURS || 6) * 60 * 60 * 1000;
const WARM_MS = 30 * 24 * 60 * 60 * 1000;
const lastHit = new Array(SITES.length).fill(0);
const lastPoll = new Array(SITES.length).fill(0);   // when we last POLLED a site (not when it produced)
let queue = [];
let passNo = 0;
let passSize = 0;
let tiers = { hot: 0, hotPolled: 0, hotDeferred: 0, warm: 0, cold: 0, deep: 0 };


// Seed the adaptive tiers from the archive so they survive restarts. Called once at boot,
// after the archive connects. Failure here is not fatal — the sweep simply starts cold,
// which is exactly the old behaviour.
async function seedTiersFromArchive(archive) {
  if (!archive || typeof archive.lastSeenBySite !== "function") return 0;
  try {
    if (!archive.isReady()) {
      // This was a silent no-op once: seeding ran before archive.init() had connected,
      // returned nothing, and logged nothing. Say so rather than pretending it worked.
      console.warn("[sweep] archive not ready at seed time — tiers start cold");
      return 0;
    }
    const seen = await archive.lastSeenBySite({ days: 30 });
    if (!Object.keys(seen).length) { console.log("[sweep] archive has no site history yet — tiers start cold"); return 0; }
    let n = 0;
    SITES.forEach((site, i) => {
      const t = seen[site[0]];
      if (t && t > lastHit[i]) { lastHit[i] = t; n++; }
    });
    if (n) console.log(`[sweep] seeded ${n} sites from archive — tiers survive restarts`);
    return n;
  } catch (e) {
    console.warn("[sweep] tier seed failed (starting cold):", e.message);
    return 0;
  }
}

function buildPass() {
  passNo++;
  const now = Date.now();
  const hot = [], warm = [], cold = [], deep = [];
  SITES.forEach((site, i) => {
    const age = now - lastHit[i];
    if (age < HOT_MS) hot.push(i);                       // productive: every pass
    else if (lastHit[i] > 0 && age < WARM_MS) warm.push(i);
    else if (site[4]) deep.push(i);                      // never-hit deep cell: slowest tier
    else cold.push(i);
  });
  const warmSlice = warm.filter((_, k) => k % WARM_EVERY === passNo % WARM_EVERY);
  const coldSlice = cold.filter((_, k) => k % COLD_EVERY === passNo % COLD_EVERY);
  const deepSlice = deep.filter((_, k) => k % DEEP_EVERY === passNo % DEEP_EVERY);
  // Cap the pass so breadth can never starve freshness. `extra` is ordered warm → cold →
  // deep, so trimming from the end sheds the least valuable work first: deep cells slip a
  // cycle before cold sites do, and hot sites are never dropped at all.
  let extra = warmSlice.concat(coldSlice, deepSlice);

  // Safety net: if hot alone exceeds the cap, poll the least-recently-polled hot sites
  // first and let the rest slip a pass. Without this the same sites would win every time.
  // RESERVE keeps a few slots for breadth so cold and deep never stall completely.
  const RESERVE = Number(process.env.SWEEP_RESERVE || 8);
  const trueHot = hot.length;            // record BEFORE trimming, or we report the cap back
  let hotDeferred = 0;
  if (hot.length > MAX_PASS - RESERVE) {
    hot.sort((a, b) => lastPoll[a] - lastPoll[b]);
    hotDeferred = hot.length - Math.max(1, MAX_PASS - RESERVE);
    hot.length = Math.max(1, MAX_PASS - RESERVE);
  }
  const room = Math.max(0, MAX_PASS - hot.length);
  if (extra.length > room) extra = extra.slice(0, room);
  // interleave so the pass is not front-loaded with hot sites
  const out = [];
  const step = extra.length ? Math.max(1, Math.round(hot.length / extra.length)) : Infinity;
  let ci = 0;
  hot.forEach((h, i) => { out.push(h); if ((i + 1) % step === 0 && ci < extra.length) out.push(extra[ci++]); });
  while (ci < extra.length) out.push(extra[ci++]);
  queue = out.length ? out : SITES.map((_, i) => i);
  passSize = queue.length;
  tiers = { hot: trueHot, hotPolled: hot.length, hotDeferred, warm: warm.length, cold: cold.length, deep: deep.length };
  return passSize;
}
let cycles = 0, sweepErrors = 0, lastSweepAt = null;


// Distance from an aircraft to a polling site, in nautical miles.
// Needed because sites are polled over a 250nm radius and those radii overlap heavily:
// one aircraft over Alabama sits inside the circles of Eglin, Maxwell, Keesler and more.
function distNm(lat, lon, sLat, sLon) {
  const dy = (lat - sLat) * 60;
  const dx = (lon - sLon) * 60 * Math.cos(((lat + sLat) / 2) * Math.PI / 180);
  return Math.hypot(dx, dy);
}

function record(a, site, cls) {
  const now = Date.now();
  const prev = seen.get(a.id);
  const point = [Math.round(a.lat * 1000) / 1000, Math.round(a.lon * 1000) / 1000, now];
  if (prev) {
    prev.lastSeen = now;
    prev.lat = a.lat; prev.lon = a.lon;
    prev.altFt = a.altFt; prev.groundSpeedKt = a.groundSpeedKt; prev.headingDeg = a.headingDeg;
    // Attribute to the NEAREST site, not the most recent one to poll. Previously this line
    // overwrote site unconditionally, so an aircraft 20nm from Maxwell could be filed under
    // Eglin purely because Eglin's turn in the rotation came later — arbitrary attribution,
    // and the same aircraft landing under several sites inflated every overlapping circle.
    const dHere = distNm(a.lat, a.lon, site[2], site[3]);
    if (prev.siteDistNm == null || dHere < prev.siteDistNm) {
      prev.site = site[0]; prev.country = site[1];
      prev.siteLat = site[2]; prev.siteLon = site[3];
      prev.siteDistNm = Math.round(dHere * 10) / 10;
    }
    prev.callsign = a.callsign || prev.callsign;
    prev.kind = cls.kind; prev.why = cls.why; prev.confidence = cls.confidence;
    if (prev.track.length === 0 || now - prev.track[prev.track.length - 1][2] > 60000) {
      prev.track.push(point);
      if (prev.track.length > 240) prev.track.shift();   // ~4h of one-minute points
      archive.record(prev);                              // durable copy (no-op if archive disabled)
    }
    return;
  }
  if (seen.size >= MAX_TRACKED) return;                  // bounded memory
  seen.set(a.id, {
    id: a.id, kind: cls.kind, why: cls.why, confidence: cls.confidence,
    callsign: a.callsign || null, typeCode: a.typeCode || null,
    registration: a.registration || null, desc: a.desc || null, military: a.military ?? null,
    lat: a.lat, lon: a.lon, altFt: a.altFt, groundSpeedKt: a.groundSpeedKt, headingDeg: a.headingDeg,
    site: site[0], country: site[1], siteLat: site[2], siteLon: site[3],
    siteDistNm: Math.round(distNm(a.lat, a.lon, site[2], site[3]) * 10) / 10,
    firstSeen: now, lastSeen: now, track: [point],
  });
  archive.record(seen.get(a.id));
}

function prune() {
  const cutoff = Date.now() - RETAIN_MS;
  for (const [id, s] of seen) if (s.lastSeen < cutoff) seen.delete(id);
}

async function sweepOnce() {
  if (queue.length === 0) { cycles++; buildPass(); if (cycles > 0) prune(); }
  const idx = queue.shift();
  if (idx != null) lastPoll[idx] = Date.now();    // fairness bookkeeping for the hot rotation
  const site = SITES[idx];
  try {
    const data = await fetchAircraft(site[2], site[3], RADIUS_NM);
    let hits = 0;
    (data.aircraft || []).forEach((a) => { const cls = classify(a); if (cls) { record(a, site, cls); hits++; } });
    if (hits) lastHit[idx] = Date.now();      // keep this airspace in the fast rotation
    lastSweepAt = Date.now();
  } catch (e) {
    sweepErrors++;
    if (sweepErrors % 20 === 1) console.error("[sweep]", site[0], (e && e.message) || e);
  }
}

function start() {
  if (process.env.SWEEP_DISABLED === "1") { console.log("[sweep] disabled"); return null; }
  console.log(`[sweep] watching ${SITES.length} UAV airspaces, one per ${SITE_INTERVAL_MS / 1000}s`);
  archive.init();
  sweepOnce();
  const id = setInterval(sweepOnce, SITE_INTERVAL_MS);
  setInterval(() => {
    const live = getDrones().count;
    console.log(`[sweep] cycle=${cycles} tracked=${seen.size} live=${live} errors=${sweepErrors}`);
  }, 300000);
  return id;
}

// Contacts seen within `sinceMs` (default: 15 min = "airborne now, as far as we know")
function getDrones(sinceMs = 15 * 60 * 1000) {
  const cutoff = Date.now() - sinceMs;
  const drones = Array.from(seen.values())
    .filter((s) => s.lastSeen >= cutoff)
    .sort((a, b) => b.lastSeen - a.lastSeen)
    .map(({ track, ...rest }) => ({ ...rest, trackPoints: track.length }));
  const byKind = drones.reduce((m, d) => ((m[d.kind] = (m[d.kind] || 0) + 1), m), {});
  return {
    source: "airplanes.live · ADS-B (category B6, UAV type codes, military registry flag)",
    updated: new Date().toISOString(),
    sweep: {
      sites: SITES.length,
      // Exposed so the UI can STATE the real coverage instead of hardcoding a figure that goes
      // stale silently every time a site is added — which it did twice in one night.
      //
      // Two traps here, both hit on the first attempt: SITES already CONTAINS the deep-grid cells
      // (they are pushed in below), so sites+deepCells double-counts them; and every grid cell
      // carries the country string 'Deep sweep', which counted as a 173rd country. Named sites and
      // real countries are therefore computed by excluding the grid explicitly.
      namedSites: SITES.filter((x) => x[1] !== 'Deep sweep').length,
      countries: new Set(SITES.filter((x) => x[1] !== 'Deep sweep').map((x) => x[1])).size,
      visited: Math.max(0, (queue.length ? passSize - queue.length : passSize)),
      passSize,
      hotSites: tiers.hot,                 // airspaces actually active
      hotPolled: tiers.hotPolled,          // how many fitted in this pass
      hotDeferred: tiers.hotDeferred,      // active but slipped to the next pass
      warmSites: tiers.warm,
      coldSites: tiers.cold,
      deepCells: tiers.deep,
      cycles, lastSweepAt, errors: sweepErrors, tracked24h: seen.size,
      intervalSec: SITE_INTERVAL_MS / 1000,
    },
    count: drones.length,
    counts: {
      uav: byKind.uav || 0,
      military: byKind.military || 0,
      disputed: drones.filter((d) => d.confidence === "disputed").length,
    },
    note: "Only aircraft that broadcast ADS-B appear; aircraft with transponders off are invisible to every public feed. ADS-B emitter category is self-declared, so contacts marked 'disputed' broadcast as unmanned while the registry names a manned airframe.",
    drones,
  };
}

function getTrack(id) {
  const s = seen.get(String(id).toLowerCase()) || seen.get(String(id));
  if (!s) return null;
  return { id: s.id, callsign: s.callsign, site: s.site, firstSeen: s.firstSeen, lastSeen: s.lastSeen, track: s.track };
}

module.exports = { start, getDrones, getTrack, seedTiersFromArchive, SITES, _buildPass: buildPass, _seen: seen, _sweepOnce: sweepOnce };
