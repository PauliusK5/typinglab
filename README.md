# TypingLab

A full-stack web application for measuring typing speed and accuracy.

## Overview
TypingLab is an independently built project exploring human–computer
interaction, real-time feedback, and performance measurement.

## Tech Stack
- Backend: Python, FastAPI
- Frontend: HTML, CSS, Vanilla JavaScript
- Database: SQLite

## Features
- Real-time typing test
- Accuracy-aware WPM calculation
- User authentication
- Session storage and visualization
- Three training modes
- ELO rankings

## Running locally
```bash
pip install -r requirements.txt
uvicorn main:app --reload
