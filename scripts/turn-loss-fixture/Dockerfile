ARG CONTROLLER_BASE_IMAGE
FROM ${CONTROLLER_BASE_IMAGE}

RUN apk add --no-cache iptables
WORKDIR /fixture
COPY controller.py /fixture/controller.py
