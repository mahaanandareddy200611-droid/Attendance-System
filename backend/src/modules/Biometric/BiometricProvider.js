class BiometricProvider {

    async enroll() {
        throw new Error(
            "BiometricProvider.enroll() not implemented"
        );
    }


    async verify() {
        throw new Error(
            "BiometricProvider.verify() not implemented"
        );
    }
}

module.exports =
    BiometricProvider;