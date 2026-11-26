FROM golang:1.26-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY *.go ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /hinacode-relayd . && mkdir /certs

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /hinacode-relayd /hinacode-relayd
COPY --from=build --chown=nonroot:nonroot /certs /certs
EXPOSE 8443
ENTRYPOINT ["/hinacode-relayd"]
