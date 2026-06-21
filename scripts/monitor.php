#!/usr/bin/env php
<?php
/**
 * GovStatus BR — Monitor concorrente leve (CLI)
 * Uso: php scripts/monitor.php [--discover]
 */

declare(strict_types=1);

$baseDir = dirname(__DIR__);
$agenciesFile = $baseDir . '/data/agencies.json';
$statusFile = $baseDir . '/data/status.json';
$historyFile = $baseDir . '/data/history.json';

const MAX_HISTORY = 288; // ~24h a cada 5 min (ajuste conforme cron)
const SLOW_MS = 8000; // gov.br costuma ser lento; evita falso "instável"
const TIMEOUT = 12;
const OFFLINE_CONFIRM_CHECKS = 2; // exige falhas consecutivas antes de marcar offline

function loadJson(string $path): array
{
    if (!file_exists($path)) {
        return [];
    }
    $data = json_decode(file_get_contents($path), true);
    return is_array($data) ? $data : [];
}

function saveJson(string $path, array $data): void
{
    file_put_contents($path, json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));
}

function resolveUrl(string $base, string $path): string
{
    if (str_starts_with($path, 'http')) {
        return $path;
    }
    $parts = parse_url($base);
    $scheme = $parts['scheme'] ?? 'https';
    $host = $parts['host'] ?? '';
    return $scheme . '://' . $host . '/' . ltrim($path, '/');
}

function discoverMetadata(array &$agencies): void
{
    foreach ($agencies as &$agency) {
        $url = $agency['base_url'];
        $ctx = stream_context_create([
            'http' => [
                'timeout' => 10,
                'header' => "User-Agent: GovStatusBR/1.0 (+https://rafaelferreiradasilva.com.br/gov-status/)\r\n",
            ],
            'ssl' => ['verify_peer' => true, 'verify_peer_name' => true],
        ]);

        $html = @file_get_contents($url, false, $ctx);
        if ($html === false) {
            echo "✗ Discover falhou: {$agency['name']}\n";
            continue;
        }

        if (empty($agency['logo_url'])) {
            if (preg_match('/<meta[^>]+property=["\']og:image["\'][^>]+content=["\']([^"\']+)["\']/i', $html, $m)) {
                $agency['logo_url'] = $m[1];
            } elseif (preg_match('/<link[^>]+rel=["\'](?:icon|shortcut icon|apple-touch-icon)["\'][^>]+href=["\']([^"\']+)["\']/i', $html, $m)) {
                $agency['logo_url'] = resolveUrl($url, $m[1]);
            }
        }

        preg_match_all('/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i', $html, $emails);
        $existing = array_column($agency['contacts'] ?? [], 'value');
        foreach (array_unique($emails[0] ?? []) as $email) {
            $email = strtolower($email);
            if (str_contains($email, 'example.') || str_contains($email, 'w3.org')) {
                continue;
            }
            if (!in_array($email, $existing, true)) {
                $agency['contacts'][] = ['type' => 'email', 'value' => $email];
            }
        }

        echo "✔ Discover: {$agency['name']}\n";
        usleep(500000);
    }
    unset($agency);
}

function probeUrl(string $url): array
{
    $ch = curl_init();
    curl_setopt_array($ch, [
        CURLOPT_URL => $url,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_MAXREDIRS => 5,
        CURLOPT_TIMEOUT => TIMEOUT,
        CURLOPT_CONNECTTIMEOUT => 6,
        CURLOPT_USERAGENT => 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 GovStatusBR/1.0',
        CURLOPT_SSL_VERIFYPEER => true,
        CURLOPT_ENCODING => '',
        CURLOPT_HTTPHEADER => ['Accept: text/html,application/xhtml+xml', 'Accept-Language: pt-BR,pt;q=0.9'],
    ]);

    curl_exec($ch);
    $code = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $time = (int) round(curl_getinfo($ch, CURLINFO_TOTAL_TIME) * 1000);
    $error = curl_error($ch);
    curl_close($ch);

    if ($error !== '') {
        return ['status_code' => 0, 'response_time_ms' => 0, 'is_online' => false, 'state' => 'offline'];
    }

    if ($code >= 200 && $code < 400) {
        $state = $time >= SLOW_MS ? 'unstable' : 'online';
        return ['status_code' => $code, 'response_time_ms' => $time, 'is_online' => true, 'state' => $state];
    }

    if ($code === 403) {
        // WAF respondeu — site existe, mas bloqueou o robô
        return ['status_code' => $code, 'response_time_ms' => $time, 'is_online' => true, 'state' => 'unstable'];
    }

    if ($code >= 500) {
        return ['status_code' => $code, 'response_time_ms' => $time, 'is_online' => false, 'state' => 'offline'];
    }

    // 404/410 etc — pode ser URL errada, não necessariamente site caído
    return ['status_code' => $code, 'response_time_ms' => $time, 'is_online' => false, 'state' => 'offline'];
}

function checkAgencies(array $agencies, array $history): array
{
    $mh = curl_multi_init();
    $handles = [];
    $results = [];

    foreach ($agencies as $agency) {
        $ch = curl_init();
        curl_setopt_array($ch, [
            CURLOPT_URL => $agency['base_url'],
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_FOLLOWLOCATION => true,
            CURLOPT_MAXREDIRS => 5,
            CURLOPT_TIMEOUT => TIMEOUT,
            CURLOPT_CONNECTTIMEOUT => 6,
            CURLOPT_USERAGENT => 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 GovStatusBR/1.0',
            CURLOPT_SSL_VERIFYPEER => true,
            CURLOPT_ENCODING => '',
            CURLOPT_HTTPHEADER => ['Accept: text/html,application/xhtml+xml', 'Accept-Language: pt-BR,pt;q=0.9'],
        ]);
        curl_multi_add_handle($mh, $ch);
        $handles[(int) $ch] = ['ch' => $ch, 'id' => $agency['id'], 'url' => $agency['base_url']];
    }

    $running = null;
    do {
        curl_multi_exec($mh, $running);
        curl_multi_select($mh, 1.0);
    } while ($running > 0);

    foreach ($handles as $info) {
        $ch = $info['ch'];
        $id = $info['id'];
        $code = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $time = (int) round(curl_getinfo($ch, CURLINFO_TOTAL_TIME) * 1000);
        $error = curl_error($ch);

        if ($error !== '') {
            $check = ['status_code' => 0, 'response_time_ms' => 0, 'is_online' => false, 'state' => 'offline'];
        } elseif ($code >= 200 && $code < 400) {
            $state = $time >= SLOW_MS ? 'unstable' : 'online';
            $check = ['status_code' => $code, 'response_time_ms' => $time, 'is_online' => true, 'state' => $state];
        } elseif ($code === 403) {
            $check = ['status_code' => $code, 'response_time_ms' => $time, 'is_online' => true, 'state' => 'unstable'];
        } elseif ($code >= 500) {
            $check = ['status_code' => $code, 'response_time_ms' => $time, 'is_online' => false, 'state' => 'offline'];
        } else {
            $check = ['status_code' => $code, 'response_time_ms' => $time, 'is_online' => false, 'state' => 'offline'];
        }

        // Retry único em falha para reduzir falso positivo
        if (!$check['is_online']) {
            usleep(300000);
            $retry = probeUrl($info['url']);
            if ($retry['is_online']) {
                $check = $retry;
            }
        }

        // Exige falhas consecutivas no histórico antes de marcar offline
        if (!$check['is_online']) {
            $recent = array_slice($history[$id] ?? [], -OFFLINE_CONFIRM_CHECKS);
            $recentFails = count(array_filter($recent, fn($e) => !($e['online'] ?? true)));
            if ($recentFails < OFFLINE_CONFIRM_CHECKS - 1) {
                $check['state'] = 'unstable';
            }
        }

        $results[$id] = $check;
        curl_multi_remove_handle($mh, $ch);
        curl_close($ch);
    }

    curl_multi_close($mh);
    return $results;
}

function uptimePercent(array $entries): float
{
    if (count($entries) === 0) {
        return 100.0;
    }
    $online = count(array_filter($entries, fn($e) => $e['online'] ?? false));
    return round(($online / count($entries)) * 100, 1);
}

function buildIncidents(array $entries): array
{
    $incidents = [];
    $current = null;

    foreach ($entries as $entry) {
        $down = !($entry['online'] ?? true);
        if ($down && $current === null) {
            $current = ['start' => $entry['t'], 'code' => $entry['code'] ?? 0];
        } elseif (!$down && $current !== null) {
            $incidents[] = [
                'start' => $current['start'],
                'end' => $entry['t'],
                'status_code' => $current['code'],
                'duration_min' => max(1, (int) round(($entry['t'] - $current['start']) / 60)),
            ];
            $current = null;
        }
    }

    if ($current !== null) {
        $incidents[] = [
            'start' => $current['start'],
            'end' => null,
            'status_code' => $current['code'],
            'duration_min' => null,
        ];
    }

    return array_reverse(array_slice($incidents, -20));
}

// --- Main ---

$discover = in_array('--discover', $argv ?? [], true);
$data = loadJson($agenciesFile);
$agencies = $data['agencies'] ?? [];

if (empty($agencies)) {
    fwrite(STDERR, "Nenhum órgão em data/agencies.json\n");
    exit(1);
}

if ($discover) {
    discoverMetadata($agencies);
    $data['agencies'] = $agencies;
    saveJson($agenciesFile, $data);
    echo "Discover concluído.\n";
    if (!in_array('--check', $argv ?? [], true)) {
        exit(0);
    }
}

echo "Checando " . count($agencies) . " órgãos...\n";
$history = loadJson($historyFile);
$checks = checkAgencies($agencies, $history);
$now = time();

foreach ($agencies as $agency) {
    $id = $agency['id'];
    $check = $checks[$id] ?? ['status_code' => 0, 'response_time_ms' => 0, 'is_online' => false, 'state' => 'offline'];

    if (!isset($history[$id])) {
        $history[$id] = [];
    }

    $history[$id][] = [
        't' => $now,
        'ms' => $check['response_time_ms'],
        'online' => $check['is_online'],
        'code' => $check['status_code'],
        'state' => $check['state'],
    ];

    if (count($history[$id]) > MAX_HISTORY) {
        $history[$id] = array_slice($history[$id], -MAX_HISTORY);
    }
}

saveJson($historyFile, $history);

$online = 0;
$problems = 0;
$agencyStatus = [];
$problemNames = [];

foreach ($agencies as $agency) {
    $id = $agency['id'];
    $check = $checks[$id] ?? ['status_code' => 0, 'response_time_ms' => 0, 'is_online' => false, 'state' => 'offline'];
    $entries = $history[$id] ?? [];

    if ($check['state'] === 'online') {
        $online++;
    } else {
        $problems++;
        $problemNames[] = $agency['name'];
    }

    $agencyStatus[$id] = [
        'status' => $check['state'],
        'status_code' => $check['status_code'],
        'response_time_ms' => $check['response_time_ms'],
        'uptime_24h' => uptimePercent($entries),
        'latency_history' => array_map(fn($e) => $e['ms'], array_slice($entries, -24)),
        'last_check' => date('c', $now),
        'incidents' => buildIncidents($entries),
    ];

    $label = strtoupper($check['state']);
    echo "{$agency['name']}: {$label} ({$check['status_code']}) {$check['response_time_ms']}ms\n";
}

$total = count($agencies);
$uptimeGlobal = $total > 0 ? round(($online / $total) * 100, 1) : 100;

$alert = ['active' => false, 'message' => '', 'level' => 'ok'];
if ($problems >= 3) {
    $alert = [
        'active' => true,
        'message' => 'ATENÇÃO: Alta instabilidade detectada em ' . implode(', ', array_slice($problemNames, 0, 4)) . '.',
        'level' => 'critical',
    ];
} elseif ($problems >= 1) {
    $alert = [
        'active' => true,
        'message' => 'Instabilidade detectada em: ' . implode(', ', $problemNames) . '.',
        'level' => 'warning',
    ];
}

$status = [
    'updated_at' => date('c'),
    'global' => [
        'total' => $total,
        'online' => $online,
        'problems' => $problems,
        'uptime_percent' => $uptimeGlobal,
    ],
    'alert' => $alert,
    'agencies' => $agencyStatus,
];

saveJson($statusFile, $status);
echo "Status salvo em data/status.json\n";
