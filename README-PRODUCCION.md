# LKCO - Sistema de Gestión de Estacionamiento

Versión de código: **2.0.0**

## Operación
- Estacionamiento CECOPAK
- Estacionamiento Centro Comercial Centenario
- Automóvil
- Motocicleta
- HNL
- America/Tegucigalpa
- IVA 15%

## Servidor
- Ruta: `/opt/estacionamiento`
- Usuario Linux: `sistemadmin`
- Servicio: `estacionamiento.service`
- Puerto: `3010`
- MariaDB: base `estacionamiento`
- Usuario BD: `estacionamiento_app`

## Seguridad
- JWT mediante `JWT_SECRET` en `.env`
- Credenciales fuera del código
- Aislamiento por `id_empresa`
- Administración restringida por rol

## Publicación
Nginx puede publicar el sistema y reenviar hacia `127.0.0.1:3010`. La publicación externa por Cable Color es independiente del código de la aplicación.
