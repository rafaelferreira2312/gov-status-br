# GovStatus BR

Monitoramento open source em tempo real dos serviços públicos digitais brasileiros.

**Demo:** [rafaelferreiradasilva.com.br/gov-status/](https://rafaelferreiradasilva.com.br/gov-status/)

## O que faz

- Checa uptime e latência de portais `.gov.br` a cada minuto
- Dashboard dark mode com alertas por criticidade
- Página de detalhes por órgão com histórico e timeline de incidentes
- Robô leve em PHP (sem Laravel) usando `curl_multi` concorrente
- Descoberta automática de logos (Open Graph / favicon) e e-mails (`--discover`)

## Stack

- HTML · CSS · JavaScript (estático)
- PHP 8+ CLI para monitoramento
- JSON como banco de dados (zero infra extra)

## Estrutura

```
gov-status-br/
├── index.html          # Dashboard geral
├── orgao.html          # Detalhe do órgão
├── assets/
├── data/
│   ├── agencies.json   # Cadastro de órgãos
│   ├── status.json     # Status atual (gerado)
│   └── history.json    # Histórico (gerado)
└── scripts/
    └── monitor.php     # Robô de monitoramento
```

## Executar

```bash
# Checagem de uptime
php scripts/monitor.php

# Descobrir logos e e-mails
php scripts/monitor.php --discover

# Discover + checagem
php scripts/monitor.php --discover --check
```

## Cron (produção)

```cron
*/5 * * * * cd /caminho/gov-status-br && php scripts/monitor.php >> /var/log/gov-status.log 2>&1
0 3 * * 0 cd /caminho/gov-status-br && php scripts/monitor.php --discover >> /var/log/gov-status-discover.log 2>&1
```

## Adicionar órgãos

Edite `data/agencies.json` e adicione entradas com `id`, `slug`, `name`, `sphere`, `base_url`.

## Licença

Apache-2.0
