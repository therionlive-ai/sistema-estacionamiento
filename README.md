# Estacionamiento LKCO

Sistema de Gestión de Estacionamiento para LKCO S.A. de C.V.

## Establecimientos
- Estacionamiento CECOPAK
- Estacionamiento Centro Comercial Centenario

## Vehículos
- Automóvil
- Motocicleta

No se utiliza selector manual de establecimiento: el establecimiento se determina por el usuario autenticado.

## Stack
- Node.js + Express
- MariaDB
- JWT
- Bootstrap / JavaScript
- ExcelJS

## Configuración de operación
- Moneda: HNL
- Zona horaria: America/Tegucigalpa
- IVA: 15%
- Puerto por defecto: 3010
- Base de datos: estacionamiento

## Usuarios iniciales
- admin_cecopak → Estacionamiento CECOPAK
- admin_centenario → Estacionamiento Centro Comercial Centenario

Las credenciales reales se configuran fuera del código mediante la base de datos y el archivo `.env`.

## Desarrollo
1. Copiar `.env.example` como `.env`.
2. Configurar las credenciales de MariaDB y `JWT_SECRET`.
3. Ejecutar `npm install`.
4. Ejecutar `npm start`.

## Producción Linux
- Aplicación: `/opt/estacionamiento`
- Usuario: `sistemadmin`
- Servicio: `estacionamiento.service`
- Node escucha en `0.0.0.0:3010` cuando se ejecuta directamente.

## Nota
No incluir `.env` en repositorios ni paquetes compartidos.
