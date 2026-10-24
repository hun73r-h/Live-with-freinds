FROM python:3.12-slim

WORKDIR /app

COPY . .

ENV PYTHONUNBUFFERED=1
ENV PORT=10000

EXPOSE 10000

CMD ["python", "server.py"]
